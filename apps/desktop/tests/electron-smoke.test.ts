import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

const desktopRoot = resolve(import.meta.dirname, "..");
const electronBinary = join(
  desktopRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);

// The Electron binary is fetched by electron's install script, which bun
// deliberately does not run (this repo forbids trusting lifecycle scripts).
// Where the binary is absent — CI, or a fresh clone before the documented
// one-time fetch — the smoke test skips instead of failing; every other
// boundary test still runs.
const electronAvailable = existsSync(electronBinary);

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("electron startup smoke", () => {
  test(
    "the built app starts, opens the database, loads the renderer, and exits cleanly",
    { skip: electronAvailable ? false : "electron binary not installed" },
    async () => {
      execFileSync(process.execPath, [join(desktopRoot, "build.mjs")], {
        cwd: desktopRoot,
        stdio: "pipe",
      });
      assert.equal(existsSync(join(desktopRoot, "dist", "main.cjs")), true);
      assert.equal(
        existsSync(join(desktopRoot, "dist", "native", "better_sqlite3.node")),
        true,
        "build must stage the Electron-ABI better-sqlite3 binary",
      );

      // Canonicalized because main.ts canonicalizes the userData path before
      // deriving the data directory it reports back.
      const userDataDirectory = realpathSync.native(
        mkdtempSync(join(tmpdir(), "job-agent-smoke-")),
      );
      temporaryDirectories.push(userDataDirectory);

      const result = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
        timedOut: boolean;
      }>((resolvePromise) => {
        // ELECTRON_RUN_AS_NODE in the inherited environment would silently turn
        // the Electron binary into plain Node; strip it so the smoke test always
        // exercises the real Electron runtime.
        const childEnvironment: NodeJS.ProcessEnv = {
          ...process.env,
          JOB_AGENT_SMOKE_TEST: "1",
          JOB_AGENT_USER_DATA_DIR: userDataDirectory,
          ELECTRON_ENABLE_LOGGING: "1",
        };
        delete childEnvironment.ELECTRON_RUN_AS_NODE;
        const child = spawn(electronBinary, ["."], {
          cwd: desktopRoot,
          env: childEnvironment,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, 60_000);
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("close", (code) => {
          clearTimeout(timeout);
          resolvePromise({ code, stdout, stderr, timedOut });
        });
      });

      assert.equal(result.timedOut, false, `electron did not exit; stderr: ${result.stderr}`);
      // The marker is printed only after main has read the renderer's DOM and
      // seen the validated getSettings() response arrive through the real
      // preload bridge — a loaded page alone does not produce it.
      const marker = result.stdout.match(/JOB_AGENT_SMOKE_OK (\{.*\})/);
      assert.ok(
        marker?.[1],
        `bridge-verified startup marker missing; stdout: ${result.stdout}; stderr: ${result.stderr}`,
      );
      const { dataDirectory } = JSON.parse(marker[1]) as { dataDirectory: string };
      assert.ok(
        dataDirectory.startsWith(userDataDirectory),
        `renderer-reported data directory ${dataDirectory} must live under ${userDataDirectory}`,
      );
      assert.equal(result.code, 0, `electron exited with ${result.code}; stderr: ${result.stderr}`);
      assert.equal(
        existsSync(join(userDataDirectory, "data", "job-agent.sqlite3")),
        true,
        "the database must be created beneath the userData directory",
      );
    },
  );
});
