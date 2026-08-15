import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, test } from "node:test";
import { resolveRuntimePaths } from "../src/main/runtime-paths.ts";

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");
// The exact value main.ts passes as applicationSourceDirectory in development.
const developmentAppPath = resolve(import.meta.dirname, "..");
const fakeUserData = resolve(sep, "synthetic-users", "synthetic", "AppData", "job-agent");

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "job-agent-paths-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime path resolution", () => {
  test("places all runtime data beneath the userData directory", () => {
    const paths = resolveRuntimePaths({
      userDataDirectory: fakeUserData,
      applicationSourceDirectory: repositoryRoot,
    });
    assert.equal(paths.dataDirectory, join(fakeUserData, "data"));
    assert.equal(paths.databaseFile, join(fakeUserData, "data", "job-agent.sqlite3"));
    assert.equal(paths.databaseFile.startsWith(fakeUserData + sep), true);
  });

  test("refuses to place runtime data inside the application source tree", () => {
    assert.throws(
      () =>
        resolveRuntimePaths({
          userDataDirectory: join(repositoryRoot, "user-data"),
          applicationSourceDirectory: repositoryRoot,
        }),
      /outside the application source tree/,
    );
    assert.throws(
      () =>
        resolveRuntimePaths({
          userDataDirectory: repositoryRoot,
          applicationSourceDirectory: repositoryRoot,
        }),
      /outside the application source tree/,
    );
  });

  test("refuses to place runtime data inside this repository checkout", () => {
    assert.throws(
      () =>
        resolveRuntimePaths({
          userDataDirectory: join(repositoryRoot, "apps", "desktop", ".runtime"),
          applicationSourceDirectory: repositoryRoot,
        }),
      /outside the application source tree/,
    );
  });

  test("protects the whole repository with main.ts's actual development arguments", () => {
    // In development app.getAppPath() is <repo>/apps/desktop, but a userData
    // directory anywhere inside the enclosing repository must still be refused.
    for (const userDataDirectory of [
      join(repositoryRoot, "user-data"),
      join(repositoryRoot, "packages", "database", "user-data"),
      join(developmentAppPath, ".runtime"),
    ]) {
      assert.throws(
        () =>
          resolveRuntimePaths({
            userDataDirectory,
            applicationSourceDirectory: developmentAppPath,
          }),
        /outside the application source tree/,
        `expected rejection for ${userDataDirectory}`,
      );
    }
    const allowed = resolveRuntimePaths({
      userDataDirectory: fakeUserData,
      applicationSourceDirectory: developmentAppPath,
    });
    assert.equal(allowed.dataDirectory, join(fakeUserData, "data"));
  });

  test("detects the enclosing repository root from a nested application path", () => {
    const temporary = createTemporaryDirectory();
    const fakeRepository = join(temporary, "fake-repo");
    const applicationSourceDirectory = join(fakeRepository, "apps", "desktop");
    mkdirSync(join(fakeRepository, ".git"), { recursive: true });
    mkdirSync(applicationSourceDirectory, { recursive: true });

    assert.throws(
      () =>
        resolveRuntimePaths({
          userDataDirectory: join(fakeRepository, "user-data"),
          applicationSourceDirectory,
        }),
      /outside the application source tree/,
    );
    const outside = resolveRuntimePaths({
      userDataDirectory: join(temporary, "outside-user-data"),
      applicationSourceDirectory,
    });
    assert.equal(outside.dataDirectory, join(temporary, "outside-user-data", "data"));
  });

  test("canonicalizes junctions so a link into the repository is refused", (context) => {
    const temporary = createTemporaryDirectory();
    const fakeRepository = join(temporary, "fake-repo");
    const applicationSourceDirectory = join(fakeRepository, "apps", "desktop");
    const linkTarget = join(fakeRepository, "runtime-target");
    const link = join(temporary, "innocent-looking-link");
    mkdirSync(join(fakeRepository, ".git"), { recursive: true });
    mkdirSync(applicationSourceDirectory, { recursive: true });
    mkdirSync(linkTarget, { recursive: true });
    try {
      symlinkSync(linkTarget, link, "junction");
    } catch {
      context.skip("cannot create junctions in this environment");
      return;
    }

    assert.throws(
      () =>
        resolveRuntimePaths({
          userDataDirectory: link,
          applicationSourceDirectory,
        }),
      /outside the application source tree/,
    );
  });

  test("rejects blank and relative userData directories", () => {
    assert.throws(
      () =>
        resolveRuntimePaths({
          userDataDirectory: "   ",
          applicationSourceDirectory: repositoryRoot,
        }),
      /absolute path/,
    );
    assert.throws(
      () =>
        resolveRuntimePaths({
          userDataDirectory: "relative/user-data",
          applicationSourceDirectory: repositoryRoot,
        }),
      /absolute path/,
    );
  });

  test("allows a sibling directory that merely shares a prefix", () => {
    const sibling = `${repositoryRoot}-runtime`;
    const paths = resolveRuntimePaths({
      userDataDirectory: sibling,
      applicationSourceDirectory: repositoryRoot,
    });
    assert.equal(paths.dataDirectory, join(sibling, "data"));
  });
});
