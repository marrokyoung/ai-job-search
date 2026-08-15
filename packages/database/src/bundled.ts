/**
 * Entry point for a bundled Electron main process only, exposed as
 * `@us-job-agent/database/bundled` (deliberately not re-exported from the
 * package index).
 *
 * A bundled application cannot resolve this package's own migrations
 * directory at runtime, so its build step copies the authoritative versioned
 * SQL from `packages/database/migrations/` into the bundle. This opener takes
 * one bundle directory with a fixed internal layout instead of free-form
 * overrides:
 *
 * - `<bundle>/migrations/`                  — copied migration set (required)
 * - `<bundle>/native/better_sqlite3.node`   — Electron-ABI build of
 *   better-sqlite3's native addon, used when present so the bundled runtime
 *   does not load the host-Node build.
 *
 * The general `openDatabase` API intentionally has no such parameters; the
 * versioned SQL in this package remains the single schema authority.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  openDatabaseInternal,
  type JobAgentDatabaseHandle,
} from "./database-internal.ts";

export type OpenBundledDatabaseOptions = {
  filename: string;
  /** Absolute path of the build output directory holding the bundle layout. */
  bundleDirectory: string;
};

export function openBundledDatabase(
  options: OpenBundledDatabaseOptions,
): JobAgentDatabaseHandle {
  if (!isAbsolute(options.bundleDirectory)) {
    throw new Error("The bundle directory must be an absolute path.");
  }
  const migrationsDirectory = join(options.bundleDirectory, "migrations");
  let migrationsIsDirectory = false;
  try {
    migrationsIsDirectory = statSync(migrationsDirectory).isDirectory();
  } catch {
    migrationsIsDirectory = false;
  }
  if (!migrationsIsDirectory) {
    throw new Error(
      "The bundle is missing its migrations/ copy; refusing to open the database without the authoritative schema.",
    );
  }

  const nativeBindingPath = join(
    options.bundleDirectory,
    "native",
    "better_sqlite3.node",
  );
  return openDatabaseInternal({
    filename: options.filename,
    migrationsDirectory,
    ...(existsSync(nativeBindingPath) ? { nativeBindingPath } : {}),
  });
}
