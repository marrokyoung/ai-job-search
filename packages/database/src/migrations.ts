import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

type AppliedMigration = {
  version: number;
  name: string;
  checksum: string;
};

type MigrationFile = {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
};

const migrationPattern = /^(\d+)_([a-z0-9_]+)\.sql$/;

const transactionControlKeywords = new Set([
  "begin",
  "commit",
  "end",
  "rollback",
  "savepoint",
  "release",
]);

function skipQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function* sqlTokens(sql: string): Generator<string> {
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? "";
    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      index = newline === -1 ? sql.length : newline + 1;
    } else if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      index = close === -1 ? sql.length : close + 2;
    } else if (char === "'" || char === '"' || char === "`") {
      index = skipQuoted(sql, index, char);
    } else if (char === "[") {
      const close = sql.indexOf("]", index + 1);
      index = close === -1 ? sql.length : close + 1;
    } else if (char === ";") {
      yield ";";
      index += 1;
    } else if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end] ?? "")) end += 1;
      yield sql.slice(index, end);
      index = end;
    } else {
      index += 1;
    }
  }
}

/**
 * The runner wraps each migration in exactly one transaction, so migration SQL
 * must not contain statement-level transaction control (BEGIN/COMMIT/END
 * TRANSACTION, ROLLBACK, SAVEPOINT, RELEASE) that could commit partial schema
 * changes before the ledger row is written. Trigger bodies (BEGIN ... END) and
 * CASE ... END expressions are not statements and remain allowed.
 */
function assertMigrationManagesNoTransactions(sql: string, filename: string): void {
  let atStatementStart = true;
  let statementIsCreate = false;
  let statementIsTrigger = false;
  let inTriggerBody = false;
  let caseDepth = 0;

  for (const token of sqlTokens(sql)) {
    if (token === ";") {
      if (!inTriggerBody) {
        atStatementStart = true;
        statementIsCreate = false;
        statementIsTrigger = false;
        caseDepth = 0;
      }
      continue;
    }
    const word = token.toLowerCase();
    if (atStatementStart) {
      if (transactionControlKeywords.has(word)) {
        throw new Error(
          `Migration ${filename} must not contain the transaction-control statement ` +
            `${word.toUpperCase()}; the migration runner manages one transaction per migration.`,
        );
      }
      atStatementStart = false;
      statementIsCreate = word === "create";
      continue;
    }
    if (inTriggerBody) {
      if (word === "case") {
        caseDepth += 1;
      } else if (word === "end") {
        if (caseDepth > 0) caseDepth -= 1;
        else inTriggerBody = false;
      }
      continue;
    }
    if (statementIsCreate && word === "trigger") {
      statementIsTrigger = true;
    } else if (statementIsTrigger && word === "begin") {
      inTriggerBody = true;
    }
  }
}

export function runMigrations(
  sqlite: Database.Database,
  migrationsDirectory: string,
): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const applied = new Map(
    sqlite
      .prepare("SELECT version, name, checksum FROM schema_migrations")
      .all()
      .map((row) => {
        const migration = row as AppliedMigration;
        return [migration.version, migration] as const;
      }),
  );

  const filenames = readdirSync(migrationsDirectory);
  const invalidSqlFilename = filenames.find(
    (filename) => filename.endsWith(".sql") && !migrationPattern.test(filename),
  );
  if (invalidSqlFilename) {
    throw new Error(
      `Migration filename ${invalidSqlFilename} must match <positive-version>_<name>.sql.`,
    );
  }

  const migrations = filenames
    .flatMap((filename): MigrationFile[] => {
      const match = migrationPattern.exec(filename);
      if (!match) return [];
      const version = Number(match[1]);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new Error(`Migration ${filename} has an invalid positive integer version.`);
      }
      const sql = readFileSync(join(migrationsDirectory, filename), "utf8");
      assertMigrationManagesNoTransactions(sql, filename);
      return [{
        version,
        name: match[2] ?? "unnamed",
        filename,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      }];
    })
    .sort((left, right) =>
      left.version - right.version || left.filename.localeCompare(right.filename),
    );

  if (migrations.length === 0) {
    throw new Error("The migration directory contains no versioned SQL migrations.");
  }

  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (!migration) continue;
    const previousFile = migrations[index - 1];
    if (previousFile?.version === migration.version) {
      throw new Error(
        `Duplicate migration version ${migration.version}: ${previousFile.filename} and ${migration.filename}.`,
      );
    }
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `Migration versions must be contiguous from 1; expected ${expectedVersion}, found ${migration.version} in ${migration.filename}.`,
      );
    }
  }

  const migrationsByVersion = new Map(
    migrations.map((migration) => [migration.version, migration] as const),
  );
  for (const previous of applied.values()) {
    const migration = migrationsByVersion.get(previous.version);
    if (!migration) {
      throw new Error(
        `Applied migration ${previous.version}_${previous.name} is missing from the migration directory.`,
      );
    }
    if (previous.name !== migration.name || previous.checksum !== migration.checksum) {
      throw new Error(
        `Applied migration ${previous.version} differs from ${migration.filename}.`,
      );
    }
  }

  const highestAppliedVersion = Math.max(0, ...applied.keys());
  for (const migration of migrations) {
    const previous = applied.get(migration.version);

    if (previous) {
      continue;
    }
    if (migration.version <= highestAppliedVersion) {
      throw new Error(
        `Unapplied migration ${migration.filename} is older than the highest applied version ${highestAppliedVersion}.`,
      );
    }

    sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      if (!sqlite.inTransaction) {
        throw new Error(
          `Migration ${migration.filename} escaped the runner's transaction before its ledger row was written.`,
        );
      }
      sqlite
        .prepare(
          `INSERT INTO schema_migrations (version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          migration.version,
          migration.name,
          migration.checksum,
          new Date().toISOString(),
        );
    })();
  }
}
