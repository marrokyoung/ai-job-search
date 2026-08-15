import { openDatabase, type JobAgentDatabase } from "@us-job-agent/database";
import { openBundledDatabase } from "@us-job-agent/database/bundled";

export type DatabaseLifecycle = {
  /** Opens the database and runs migrations. Idempotent while open. */
  open(): void;
  /** Returns the open handle, or throws if the database is not open. */
  database(): JobAgentDatabase;
  isOpen(): boolean;
  /** Closes the database. Idempotent. */
  close(): void;
};

/**
 * Owns the SQLite handle for the Electron main process. The handle never
 * leaves this module's return value; the renderer only ever sees IPC
 * responses derived from it.
 *
 * With `bundleDirectory` set (the bundled Electron build), the database opens
 * through the constrained bundled entry point, which reads the copied
 * migrations and the Electron-ABI native module from that directory. Without
 * it (plain Node, e.g. tests), the package's own authoritative migrations are
 * used directly.
 */
export function createDatabaseLifecycle(options: {
  databaseFile: string;
  bundleDirectory?: string;
}): DatabaseLifecycle {
  let handle: JobAgentDatabase | null = null;
  return {
    open() {
      if (handle) return;
      handle =
        options.bundleDirectory === undefined
          ? openDatabase({ filename: options.databaseFile })
          : openBundledDatabase({
              filename: options.databaseFile,
              bundleDirectory: options.bundleDirectory,
            });
    },
    database() {
      if (!handle) throw new Error("The database is not open.");
      return handle;
    },
    isOpen() {
      return handle !== null;
    },
    close() {
      if (!handle) return;
      handle.close();
      handle = null;
    },
  };
}
