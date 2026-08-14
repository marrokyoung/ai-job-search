import type Database from "better-sqlite3";

export type InternalDatabaseHandle = object;

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
