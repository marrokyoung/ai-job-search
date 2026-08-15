import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations.ts";

export type InternalDatabaseHandle = object;

export type JobAgentDatabaseHandle = {
  close: () => void;
};

const connections = new WeakMap<InternalDatabaseHandle, Database.Database>();

export function registerDatabaseConnection(
  handle: InternalDatabaseHandle,
  sqlite: Database.Database,
): void {
  connections.set(handle, sqlite);
}

export function getDatabaseConnection(
  handle: InternalDatabaseHandle,
): Database.Database {
  const sqlite = connections.get(handle);
  if (!sqlite) {
    throw new Error("The database handle is closed or was not created by openDatabase().");
  }
  return sqlite;
}

export function unregisterDatabaseConnection(handle: InternalDatabaseHandle): void {
  connections.delete(handle);
}

/**
 * Shared opener behind the package's two public entry points
 * (`openDatabase` and `openBundledDatabase`). Not exported from the package
 * index: callers outside this package cannot choose an arbitrary migrations
 * source or native binding through the general API.
 */
export function openDatabaseInternal(options: {
  filename: string;
  migrationsDirectory: string;
  nativeBindingPath?: string;
}): JobAgentDatabaseHandle {
  if (options.filename !== ":memory:") {
    mkdirSync(dirname(resolve(options.filename)), { recursive: true });
  }

  const sqlite = new Database(
    options.filename,
    options.nativeBindingPath === undefined
      ? {}
      : { nativeBinding: options.nativeBindingPath },
  );
  try {
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    if (options.filename !== ":memory:") {
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("synchronous = NORMAL");
    }

    runMigrations(sqlite, options.migrationsDirectory);
  } catch (error) {
    sqlite.close();
    throw error;
  }

  let closed = false;
  const handle: JobAgentDatabaseHandle = {
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
