import { writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, app, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import { seedSyntheticData } from "@us-job-agent/database";
import { createDatabaseLifecycle } from "./database-lifecycle.ts";
import { createIpcRouter, registerIpcHandlers } from "./ipc-handlers.ts";
import { resolveRuntimePaths } from "./runtime-paths.ts";
import { createDesktopServices } from "./services.ts";
import { createStructuredLogger } from "../shared/log-redaction.ts";
import { createMainWindowOptions } from "./window-config.ts";

// One structured, redacting logger for the main process. Every value it emits
// is scrubbed of contact details, tokens, application answers, and message
// bodies before it reaches a log sink (see shared/log-redaction.ts).
const logger = createStructuredLogger();

// Test hooks (used by the Electron startup smoke test): an alternate userData
// directory and a mode that quits with a marker once startup has fully
// succeeded. Both are inert in normal runs.
const userDataOverride = process.env.JOB_AGENT_USER_DATA_DIR;
if (userDataOverride && isAbsolute(userDataOverride)) {
  app.setPath("userData", userDataOverride);
}
// Compile-time constant injected by build.mjs (esbuild `define`): the literal
// `true` in a packaging build, `false` otherwise. It is used directly in the
// seed guard below — not via an intermediate variable — so esbuild folds
// `if (!true && …)` to dead code in a packaging build and strips the synthetic
// seed entirely from the production main bundle. `declare` keeps TypeScript
// happy; main.ts only ever runs bundled, where the define is always present.
declare const __JOB_AGENT_PACKAGE_BUILD__: boolean;

const smokeTest = process.env.JOB_AGENT_SMOKE_TEST === "1";

// Fixed marker filename for the packaged smoke test. A packaged Windows app is a
// GUI-subsystem executable whose stdout is not attached to the launcher, so the
// packaged-smoke harness reads this file instead. It is written to a FIXED name
// beneath the canonical runtime directory (never a caller-supplied path) with
// EXCLUSIVE creation — see writeSmokeMarker. That makes the hook harmless even
// with a hostile environment: the only path it can ever touch is
// <userData>/data/<this name>, and only when that file does not already exist,
// so it can neither be redirected to an arbitrary path nor overwrite any file.
const SMOKE_MARKER_FILENAME = "smoke-marker.txt";

// The build step bundles this file to dist/main.cjs and places the preload
// bundle, renderer assets, the copied SQL migrations, and the Electron-ABI
// native module next to it (see build.mjs).
const distDirectory = dirname(fileURLToPath(import.meta.url));
const preloadScriptPath = join(distDirectory, "preload.cjs");
const rendererIndexPath = join(distDirectory, "renderer", "index.html");
const rendererUrl = pathToFileURL(rendererIndexPath).href;

const runtimePaths = resolveRuntimePaths({
  userDataDirectory: app.getPath("userData"),
  applicationSourceDirectory: app.getAppPath(),
});
const lifecycle = createDatabaseLifecycle({
  databaseFile: runtimePaths.databaseFile,
  bundleDirectory: distDirectory,
});

// Renderer processes run sandboxed; the preload bridge is the only bridge
// across the boundary.
app.enableSandbox();

function isTrustedSender(event: unknown): boolean {
  const senderFrame = (event as IpcMainInvokeEvent).senderFrame;
  return senderFrame !== null && senderFrame.url === rendererUrl;
}

function fatalStartupError(error: unknown): void {
  logger.log("error", "US Job Agent failed to start", {
    error: error instanceof Error ? error.message : String(error),
  });
  app.exit(1);
}

/**
 * Smoke-test proof that the whole boundary works: the renderer script calls
 * `window.jobAgent.getSettings()` through the real preload bridge and writes
 * the validated response into the DOM. Reading that DOM state back (instead
 * of trusting that the page merely loaded) fails the smoke run whenever the
 * preload bundle is broken or the IPC round trip cannot complete.
 */
async function verifySmokeStartup(window: BrowserWindow): Promise<void> {
  const readText = (id: string): Promise<string> =>
    window.webContents.executeJavaScript(
      `document.getElementById(${JSON.stringify(id)})?.textContent ?? ""`,
    ) as Promise<string>;
  const deadline = Date.now() + 15_000;
  while (true) {
    const bridgeStatus = await readText("bridge-status");
    const automationStatus = await readText("automation-status");
    const dataDirectory = await readText("data-directory");
    if (bridgeStatus.startsWith("unavailable") || automationStatus.startsWith("error:")) {
      throw new Error(
        `The renderer could not use the preload bridge (bridge: "${bridgeStatus}"; automation: "${automationStatus}").`,
      );
    }
    if (
      bridgeStatus.startsWith("available") &&
      (automationStatus === "paused" || automationStatus === "running") &&
      dataDirectory === runtimePaths.dataDirectory
    ) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for a validated settings response over IPC (bridge: "${bridgeStatus}"; automation: "${automationStatus}"; dataDirectory: "${dataDirectory}").`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

/**
 * Best-effort success marker for the packaged smoke test. Writes to a FIXED
 * filename beneath the canonical, already-validated runtime data directory
 * (never a path chosen by the caller) using exclusive creation (`flag: "wx"`),
 * which fails rather than truncating if the file already exists. Any failure is
 * swallowed: the marker is a test convenience, so it can neither overwrite an
 * existing file nor affect startup.
 */
function writeSmokeMarker(marker: string): void {
  try {
    writeFileSync(join(runtimePaths.dataDirectory, SMOKE_MARKER_FILENAME), marker, {
      flag: "wx",
    });
  } catch {
    // Fixed path + exclusive creation is intentionally strict; ignore any error.
  }
}

function createMainWindow(): void {
  const window = new BrowserWindow(createMainWindowOptions({ preloadScriptPath }));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (navigationEvent) => {
    navigationEvent.preventDefault();
  });
  if (!smokeTest) {
    window.once("ready-to-show", () => window.show());
  }
  window
    .loadFile(rendererIndexPath)
    .then(async () => {
      if (smokeTest) {
        await verifySmokeStartup(window);
        const marker = `JOB_AGENT_SMOKE_OK ${JSON.stringify({
          dataDirectory: runtimePaths.dataDirectory,
          databaseFile: runtimePaths.databaseFile,
        })}`;
        // Only the development / unpackaged smoke test (`electron .`) reads the
        // marker from stdout. A packaged build must not print runtime paths to
        // its detached stdout, so this is compiled out of packaging builds.
        if (!__JOB_AGENT_PACKAGE_BUILD__) {
          console.log(marker);
        }
        writeSmokeMarker(marker);
        app.quit();
      }
    })
    .catch(fatalStartupError);
}

void app.whenReady().then(() => {
  try {
    lifecycle.open();
    if (!__JOB_AGENT_PACKAGE_BUILD__ && !app.isPackaged) {
      // Development uses synthetic fixtures only; the seed is idempotent. This
      // branch is dead code in a packaging build (`__JOB_AGENT_PACKAGE_BUILD__`
      // is `true`), so the seed never reaches the production bundle; the
      // `!app.isPackaged` guard is a second, runtime line of defence.
      seedSyntheticData(lifecycle.database());
    }

    const services = createDesktopServices({
      getDatabase: () => lifecycle.database(),
      dataDirectory: runtimePaths.dataDirectory,
    });
    registerIpcHandlers(ipcMain, createIpcRouter(services, { isTrustedSender }));

    // Phase 1 makes no live network requests and needs no browser permissions.
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });

    app.on("web-contents-created", (_event, contents) => {
      contents.on("will-attach-webview", (attachEvent) => attachEvent.preventDefault());
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
    });

    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  } catch (error) {
    fatalStartupError(error);
  }
}, fatalStartupError);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  lifecycle.close();
});
