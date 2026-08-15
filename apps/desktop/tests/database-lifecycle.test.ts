import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { ReadModelQueries, seedSyntheticData } from "@us-job-agent/database";
import { createDatabaseLifecycle } from "../src/main/database-lifecycle.ts";
import { resolveRuntimePaths } from "../src/main/runtime-paths.ts";

const temporaryDirectories: string[] = [];

function createUserDataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "job-agent-desktop-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("main-process database lifecycle", () => {
  test("opens beneath the userData directory and persists synthetic data across restart", () => {
    const userDataDirectory = createUserDataDirectory();
    const paths = resolveRuntimePaths({
      userDataDirectory,
      applicationSourceDirectory: resolve(import.meta.dirname, "..", "..", ".."),
    });

    const firstRun = createDatabaseLifecycle({ databaseFile: paths.databaseFile });
    firstRun.open();
    assert.equal(firstRun.isOpen(), true);
    assert.equal(existsSync(paths.databaseFile), true);
    const seeded = seedSyntheticData(firstRun.database());
    firstRun.close();
    assert.equal(firstRun.isOpen(), false);

    const secondRun = createDatabaseLifecycle({ databaseFile: paths.databaseFile });
    secondRun.open();
    const queries = new ReadModelQueries(secondRun.database());
    const jobs = queries.listJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.jobId, seeded.jobId);
    const timeline = queries.getApplicationTimeline(seeded.applicationId);
    assert.ok(timeline);
    assert.equal(timeline.length, 1);
    secondRun.close();
  });

  test("refuses access when not open and stays safe on repeated open/close", () => {
    const userDataDirectory = createUserDataDirectory();
    const lifecycle = createDatabaseLifecycle({
      databaseFile: join(userDataDirectory, "data", "job-agent.sqlite3"),
    });

    assert.throws(() => lifecycle.database(), /not open/);

    lifecycle.open();
    const handle = lifecycle.database();
    lifecycle.open();
    assert.equal(lifecycle.database(), handle, "open() must be idempotent while open");

    lifecycle.close();
    lifecycle.close();
    assert.equal(lifecycle.isOpen(), false);
    assert.throws(() => lifecycle.database(), /not open/);
  });

  test("opens through the bundled entry point when a bundle directory is provided", () => {
    const userDataDirectory = createUserDataDirectory();
    const bundleDirectory = join(userDataDirectory, "fake-dist");
    cpSync(
      resolve(import.meta.dirname, "..", "..", "..", "packages", "database", "migrations"),
      join(bundleDirectory, "migrations"),
      { recursive: true },
    );
    const lifecycle = createDatabaseLifecycle({
      databaseFile: join(userDataDirectory, "data", "job-agent.sqlite3"),
      bundleDirectory,
    });
    lifecycle.open();
    assert.equal(new ReadModelQueries(lifecycle.database()).listJobs().length, 0);
    lifecycle.close();
  });

  test("a bundle without its migrations copy fails closed instead of opening unmigrated", () => {
    const userDataDirectory = createUserDataDirectory();
    const lifecycle = createDatabaseLifecycle({
      databaseFile: join(userDataDirectory, "data", "job-agent.sqlite3"),
      bundleDirectory: join(userDataDirectory, "empty-bundle"),
    });
    assert.throws(() => lifecycle.open(), /missing its migrations/);
    assert.equal(lifecycle.isOpen(), false);
    assert.equal(existsSync(join(userDataDirectory, "data", "job-agent.sqlite3")), false);
  });
});
