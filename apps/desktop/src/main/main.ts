import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, app, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import { seedSyntheticData } from "@us-job-agent/database";
import { createDatabaseLifecycle } from "./database-lifecycle.ts";
import { createIpcRouter, registerIpcHandlers } from "./ipc-handlers.ts";
import { resolveRuntimePaths } from "./runtime-paths.ts";
import { createDesktopServices } from "./services.ts";
import { createMainWindowOptions } from "./window-config.ts";

// Test hooks (used by the Electron startup smoke test): an alternate userData
// directory and a mode that quits with a marker once startup has fully
// succeeded. Both are inert in normal runs.
const userDataOverride = process.env.JOB_AGENT_USER_DATA_DIR;
if (userDataOverride && isAbsolute(userDataOverride)) {
  app.setPath("userData", userDataOverride);
}
const smokeTest = process.env.JOB_AGENT_SMOKE_TEST === "1";

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
  console.error("US Job Agent failed to start:", error);
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
        console.log(
          `JOB_AGENT_SMOKE_OK ${JSON.stringify({ dataDirectory: runtimePaths.dataDirectory })}`,
        );
        app.quit();
      }
    })
    .catch(fatalStartupError);
}

void app.whenReady().then(() => {
  try {
    lifecycle.open();
    if (!app.isPackaged) {
      // Development uses synthetic fixtures only; the seed is idempotent.
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
