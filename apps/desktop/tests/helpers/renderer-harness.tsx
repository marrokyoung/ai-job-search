/**
 * Full-stack renderer test harness. The React app under test talks to the
 * REAL preload API surface, the REAL validated IPC router, the REAL services,
 * and a REAL file-backed SQLite database (so restart persistence is
 * testable) — only Electron's process boundary is absent: `invoke` calls the
 * router directly instead of crossing ipcRenderer/ipcMain.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import {
  openDatabase,
  seedSyntheticData,
  type JobAgentDatabase,
} from "@us-job-agent/database";
import { createIpcRouter } from "../../src/main/ipc-handlers.ts";
import { createDesktopServices, type DesktopServices } from "../../src/main/services.ts";
import { createPreloadApi } from "../../src/preload/create-preload-api.ts";
import type { IpcChannel, JobAgentApi } from "../../src/shared/ipc-contract.ts";
import { App } from "../../src/renderer/app.tsx";

export type Harness = {
  api: JobAgentApi;
  database: () => JobAgentDatabase;
  dataDirectory: string;
  seeded: { jobId: string; applicationId: string } | null;
  /** Mounts the app at the given hash route (default: the dashboard). */
  renderApp: (initialHash?: string) => void;
  /** Closes and reopens the file-backed database, simulating an app restart. */
  restartDatabase: () => void;
  destroy: () => void;
};

export type HarnessOptions = {
  /** Seed the synthetic workspace (default true). */
  seed?: boolean;
  /** Wraps the services before routing, e.g. to inject failures. */
  wrapServices?: (services: DesktopServices) => DesktopServices;
  /** Wraps the finished preload API, e.g. to make one method hang. */
  patchApi?: (api: JobAgentApi) => JobAgentApi;
};

const activeHarnesses: Harness[] = [];

export function createHarness(options?: HarnessOptions): Harness {
  const directory = mkdtempSync(join(tmpdir(), "job-agent-renderer-test-"));
  const databaseFile = join(directory, "data", "job-agent.sqlite3");
  const dataDirectory = join(directory, "data");
  let database = openDatabase({ filename: databaseFile });
  const seeded = (options?.seed ?? true) ? seedSyntheticData(database) : null;

  const services = createDesktopServices({
    getDatabase: () => database,
    dataDirectory,
  });
  const router = createIpcRouter(options?.wrapServices?.(services) ?? services);
  const realApi = createPreloadApi((channel, payload) =>
    router.handle(channel as IpcChannel, {}, [payload]),
  );
  const api = options?.patchApi?.(realApi) ?? realApi;

  const harness: Harness = {
    api,
    database: () => database,
    dataDirectory,
    seeded,
    renderApp(initialHash = "#/dashboard") {
      window.location.hash = initialHash;
      window.jobAgent = api;
      render(<App />);
    },
    restartDatabase() {
      database.close();
      database = openDatabase({ filename: databaseFile });
    },
    destroy() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
      delete window.jobAgent;
    },
  };
  activeHarnesses.push(harness);
  return harness;
}

/** Standard per-test teardown: unmount, drop databases, reset navigation. */
export function resetRendererTestState(): void {
  cleanup();
  for (const harness of activeHarnesses.splice(0)) harness.destroy();
  delete window.jobAgent;
  window.location.hash = "";
}
