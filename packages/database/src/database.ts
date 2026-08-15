import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDatabaseInternal,
  type JobAgentDatabaseHandle,
} from "./database-internal.ts";

export type OpenDatabaseOptions = {
  filename: string;
};

export type JobAgentDatabase = JobAgentDatabaseHandle;

// The versioned SQL files in this package's migrations/ directory are the
// single schema authority. The general opener always uses them; a bundled
// application (which cannot ship this package's source tree) uses the
// separate, deliberately narrow entry point in bundled.ts instead.
const packageMigrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

export function openDatabase(options: OpenDatabaseOptions): JobAgentDatabase {
  return openDatabaseInternal({
    filename: options.filename,
    migrationsDirectory: packageMigrationsDirectory,
  });
}
