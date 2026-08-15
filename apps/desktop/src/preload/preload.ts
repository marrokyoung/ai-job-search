import { contextBridge, ipcRenderer } from "electron";
import { createPreloadApi } from "./create-preload-api.ts";

// The renderer receives exactly this frozen, contract-derived API and nothing
// else: no ipcRenderer, no generic invoke, no Node globals. `ipcRenderer`
// stays captured inside the closure below.
contextBridge.exposeInMainWorld(
  "jobAgent",
  createPreloadApi((channel, payload) => ipcRenderer.invoke(channel, payload)),
);
