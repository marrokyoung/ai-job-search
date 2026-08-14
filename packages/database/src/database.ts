import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  registerDatabaseConnection,
  unregisterDatabaseConnection,
} from "./database-internal.ts";
import { runMigrations } from "./migrations.ts";

export type OpenDatabaseOptions = {
  filename: string;
};

export type JobAgentDatabase = ReturnType<typeof openDatabase>;

const defaultMigrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

export function openDatabase(options: OpenDatabaseOptions) {
  if (options.filename !== ":memory:") {
    mkdirSync(dirname(resolve(options.filename)), { recursive: true });
  }

  const sqlite = new Database(options.filename);
  try {
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    if (options.filename !== ":memory:") {
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("synchronous = NORMAL");
    }

    runMigrations(sqlite, defaultMigrationsDirectory);
  } catch (error) {
    sqlite.close();
    throw error;
  }

  let closed = false;
  const handle = {
    close: () => {
      if (closed) return;
      closed = true;
      unregisterDatabaseConnection(handle);
      sqlite.close();
    },
  };
  registerDatabaseConnection(handle, sqlite);
  return handle;
}
