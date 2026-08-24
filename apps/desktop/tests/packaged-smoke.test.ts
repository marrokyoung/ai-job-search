import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { extractFile, listPackage } from "@electron/asar";

// Verifies the ACTUAL packaged application produced by `bun run package`
// (electron-builder → release/): the app.asar layout, the unpacked native
// binding, the absence of runtime/development artifacts, and a real
// preload → IPC → SQLite → renderer round trip launched from the packaged
// executable with a throwaway userData directory.
//
// The packaged output is produced by a separate, slow packaging step (the
// Windows packaging CI job runs it before this test). Where it is absent — the
// Ubuntu jobs, a fresh clone, or before a local `bun run package` — this test
// skips instead of failing, exactly like the Electron startup smoke test does
// when the Electron binary has not been fetched.

const desktopRoot = resolve(import.meta.dirname, "..");
const releaseDirectory = join(desktopRoot, "release");
const unpackedDirectory = join(releaseDirectory, "win-unpacked");
const packagedExecutable = join(unpackedDirectory, "US Job Agent.exe");
const asarPath = join(unpackedDirectory, "resources", "app.asar");
const unpackedNativeBinding = join(
  unpackedDirectory,
  "resources",
  "app.asar.unpacked",
  "dist",
  "native",
  "better_sqlite3.node",
);

const packagedAppAvailable =
  process.platform === "win32" && existsSync(packagedExecutable) && existsSync(asarPath);
const skip = packagedAppAvailable
  ? false
  : "packaged app not built (run `bun run --filter @us-job-agent/desktop package`)";

/** Normalizes asar-listed paths to forward slashes without the leading slash. */
function asarEntries(): string[] {
  return listPackage(asarPath, { isPack: false }).map((entry) =>
    entry.replace(/\\/g, "/").replace(/^\//, ""),
  );
}

function findInstaller(): string | undefined {
  if (!existsSync(releaseDirectory)) return undefined;
  const match = readdirSync(releaseDirectory).find(
    (name) => /^US Job Agent Setup .*\.exe$/.test(name),
  );
  return match ? join(releaseDirectory, match) : undefined;
}

type LaunchResult = { code: number | null; timedOut: boolean; stderr: string };

/** Launches the packaged executable with extra environment and waits for exit. */
function launchPackaged(extraEnv: Record<string, string>): Promise<LaunchResult> {
  return new Promise((resolvePromise) => {
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      JOB_AGENT_SMOKE_TEST: "1",
      ELECTRON_ENABLE_LOGGING: "1",
      ...extraEnv,
    };
    delete childEnvironment.ELECTRON_RUN_AS_NODE;
    const child = spawn(packagedExecutable, [], {
      cwd: unpackedDirectory,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 60_000);
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolvePromise({ code, timedOut, stderr });
    });
  });
}

/** The fixed, safe marker location the packaged app is allowed to write. */
function markerPathFor(userDataDirectory: string): string {
  return join(userDataDirectory, "data", "smoke-marker.txt");
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaged application", () => {
  test(
    "an installer artifact is produced",
    { skip },
    () => {
      const installer = findInstaller();
      assert.ok(installer, "expected a `US Job Agent Setup <version>.exe` in release/");
      assert.ok(existsSync(installer), `installer artifact missing: ${installer}`);
    },
  );

  test(
    "the asar contains the packaged layout and the native binding is unpacked",
    { skip },
    () => {
      const entries = asarEntries();
      const required = [
        "dist/main.cjs",
        "dist/preload.cjs",
        "dist/renderer/index.html",
        "dist/renderer/renderer.js",
        "dist/renderer/styles.css",
        "dist/migrations/0001_initial.sql",
        "dist/native/better_sqlite3.node",
        "package.json",
      ];
      for (const path of required) {
        assert.ok(entries.includes(path), `packaged asar is missing ${path}`);
      }
      // The native addon cannot load from inside the asar; electron-builder must
      // have unpacked it so the packed path redirects to the real file on disk.
      assert.ok(
        existsSync(unpackedNativeBinding),
        `native binding must be unpacked to ${unpackedNativeBinding}`,
      );
    },
  );

  test(
    "the package contains no database, WAL/SHM, log, test, source-map, or node_modules artifacts",
    { skip },
    () => {
      const entries = asarEntries();
      const forbidden: Array<{ label: string; pattern: RegExp }> = [
        { label: "SQLite database", pattern: /\.sqlite3?$/i },
        { label: "SQLite WAL/SHM", pattern: /\.sqlite3?-(wal|shm)$/i },
        { label: "log file", pattern: /\.log$/i },
        { label: "test file", pattern: /(^|\/)tests?\/|\.test\.[cm]?[jt]s$/i },
        { label: "source map", pattern: /\.map$/i },
        { label: "TypeScript source", pattern: /(^|\/)src\/|\.tsx?$/i },
        { label: "bundled node_modules", pattern: /(^|\/)node_modules\//i },
        { label: "browser profile", pattern: /(^|\/)(browser-data|user-data)\//i },
      ];
      for (const entry of entries) {
        for (const { label, pattern } of forbidden) {
          assert.ok(
            !pattern.test(entry),
            `packaged asar must not contain a ${label}: ${entry}`,
          );
        }
      }
    },
  );

  test(
    "the packaged main process carries no synthetic development seed",
    { skip },
    () => {
      const mainSource = extractFile(asarPath, "dist/main.cjs").toString("utf8");
      for (const marker of [
        "seedSyntheticData",
        "synthetic-automotive-001",
        "Example Mobility Labs",
        "Commercial Delivery Driver",
      ]) {
        assert.ok(
          !mainSource.includes(marker),
          `packaged main.cjs must not bundle the development seed (found ${marker})`,
        );
      }
    },
  );

  test(
    "the packaged main process exposes no caller-selectable smoke output path",
    { skip },
    () => {
      // The removed JOB_AGENT_SMOKE_OUT env var let a caller choose an arbitrary
      // absolute path for the marker write; it must not survive in the shipped
      // bundle (the write is now a fixed path under the runtime directory).
      const mainSource = extractFile(asarPath, "dist/main.cjs").toString("utf8");
      assert.ok(
        !mainSource.includes("JOB_AGENT_SMOKE_OUT"),
        "packaged main.cjs must not read a caller-selected smoke output path",
      );
    },
  );

  test(
    "the packaged executable completes the real IPC/SQLite round trip and writes its database only beneath the temporary runtime directory",
    { skip, timeout: 90_000 },
    async () => {
      const userDataDirectory = realpathSync.native(
        mkdtempSync(join(tmpdir(), "job-agent-pkg-smoke-")),
      );
      temporaryDirectories.push(userDataDirectory);
      const markerFile = markerPathFor(userDataDirectory);

      const result = await launchPackaged({ JOB_AGENT_USER_DATA_DIR: userDataDirectory });

      assert.equal(result.timedOut, false, `packaged app did not exit; stderr: ${result.stderr}`);
      // The marker is written to a fixed file beneath the runtime directory (a
      // packaged Windows app is a GUI-subsystem executable whose stdout is not
      // attached to the launcher). It is produced only after main reads the
      // renderer DOM and confirms the validated getSettings() response arrived
      // over the real preload bridge — see verifySmokeStartup in main.ts.
      assert.ok(existsSync(markerFile), `bridge-verified marker missing; stderr: ${result.stderr}`);
      const markerText = readFileSync(markerFile, "utf8");
      const marker = markerText.match(/JOB_AGENT_SMOKE_OK (\{.*\})/);
      assert.ok(marker?.[1], `unexpected marker contents: ${markerText}`);
      const { dataDirectory, databaseFile } = JSON.parse(marker[1]) as {
        dataDirectory: string;
        databaseFile: string;
      };

      assert.ok(
        dataDirectory.startsWith(userDataDirectory),
        `data directory ${dataDirectory} must live under the temporary userData ${userDataDirectory}`,
      );
      assert.equal(result.code, 0, `packaged app exited with ${result.code}; stderr: ${result.stderr}`);
      assert.ok(
        existsSync(databaseFile),
        `the SQLite database must be created at ${databaseFile}`,
      );
      assert.ok(
        databaseFile.startsWith(userDataDirectory),
        `the database ${databaseFile} must be created only beneath the temporary runtime directory`,
      );
      // And nothing runtime must have been written back into the packaged app.
      assert.ok(
        !existsSync(join(unpackedDirectory, "data")),
        "the packaged app directory must not accumulate a runtime data/ folder",
      );
    },
  );

  test(
    "a hostile environment cannot redirect the marker write to an outside path",
    { skip, timeout: 90_000 },
    async () => {
      const userDataDirectory = realpathSync.native(
        mkdtempSync(join(tmpdir(), "job-agent-pkg-attack-")),
      );
      temporaryDirectories.push(userDataDirectory);
      // A file OUTSIDE the runtime directory that a crafted env var tries to
      // clobber via the old caller-selected path mechanism.
      const outsideTarget = join(userDataDirectory, "outside-secret.txt");
      const sentinel = "DO-NOT-OVERWRITE";
      writeFileSync(outsideTarget, sentinel);

      const result = await launchPackaged({
        JOB_AGENT_USER_DATA_DIR: userDataDirectory,
        // The removed attack surface: point the old env var at the outside file.
        JOB_AGENT_SMOKE_OUT: outsideTarget,
      });

      assert.equal(result.timedOut, false, `packaged app did not exit; stderr: ${result.stderr}`);
      // The crafted path is ignored: the outside file is byte-for-byte unchanged.
      assert.equal(
        readFileSync(outsideTarget, "utf8"),
        sentinel,
        "a caller-selected path must never be written by the packaged app",
      );
      // The marker went to its fixed, safe location instead.
      assert.ok(
        existsSync(markerPathFor(userDataDirectory)),
        "the marker must be written to the fixed runtime-directory path",
      );
    },
  );

  test(
    "the marker write never overwrites an existing file (exclusive creation)",
    { skip, timeout: 90_000 },
    async () => {
      const userDataDirectory = realpathSync.native(
        mkdtempSync(join(tmpdir(), "job-agent-pkg-excl-")),
      );
      temporaryDirectories.push(userDataDirectory);
      // Pre-create the fixed marker path with content the app must not clobber.
      const markerFile = markerPathFor(userDataDirectory);
      mkdirSync(dirname(markerFile), { recursive: true });
      const preexisting = "PREEXISTING-CONTENT";
      writeFileSync(markerFile, preexisting);

      const result = await launchPackaged({ JOB_AGENT_USER_DATA_DIR: userDataDirectory });

      assert.equal(result.timedOut, false, `packaged app did not exit; stderr: ${result.stderr}`);
      // Exclusive creation means the app leaves the existing file untouched...
      assert.equal(
        readFileSync(markerFile, "utf8"),
        preexisting,
        "an existing marker file must never be truncated or overwritten",
      );
      // ...and a marker-write failure must not crash startup.
      assert.equal(result.code, 0, `packaged app exited with ${result.code}; stderr: ${result.stderr}`);
    },
  );
});
