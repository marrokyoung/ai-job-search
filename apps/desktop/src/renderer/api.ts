import type { JobAgentApi } from "../shared/ipc-contract.ts";

declare global {
  interface Window {
    /** The narrow typed bridge exposed by the preload script — the renderer's only capability. */
    jobAgent?: JobAgentApi;
  }
}

export function getJobAgentApi(): JobAgentApi | null {
  return window.jobAgent ?? null;
}

export type { JobAgentApi };
