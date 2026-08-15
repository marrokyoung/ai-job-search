import type { JobAgentApi } from "../shared/ipc-contract.ts";

declare global {
  interface Window {
    jobAgent?: JobAgentApi;
  }
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

async function renderShellStatus(): Promise<void> {
  const api = window.jobAgent;
  if (!api) {
    setText("bridge-status", "unavailable — preload bridge missing");
    return;
  }
  setText("bridge-status", `available (${Object.keys(api).length} methods, frozen: ${Object.isFrozen(api)})`);
  try {
    const { settings } = await api.getSettings();
    setText("automation-status", settings.automationPaused ? "paused" : "running");
    setText("data-directory", settings.dataDirectory);
  } catch (error) {
    setText("automation-status", `error: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

void renderShellStatus();
