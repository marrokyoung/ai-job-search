import {
  ipcChannels,
  type IpcChannel,
  type JobAgentApi,
} from "../shared/ipc-contract.ts";

export type InvokeFunction = (channel: IpcChannel, payload: unknown) => Promise<unknown>;

function unwrapEnvelope(envelope: unknown): unknown {
  if (typeof envelope !== "object" || envelope === null) {
    throw new Error("Malformed IPC response envelope.");
  }
  const record = envelope as Record<string, unknown>;
  if (record.ok === true) return record.data;
  if (record.ok === false) {
    const error = record.error as Record<string, unknown> | undefined;
    const message =
      typeof error?.message === "string" ? error.message : "The request failed.";
    const code = typeof error?.code === "string" ? error.code : "unknown";
    throw new Error(`${code}: ${message}`);
  }
  throw new Error("Malformed IPC response envelope.");
}

/**
 * Builds the frozen API object the preload script exposes to the renderer.
 *
 * Every method closes over one fixed channel from the contract; the renderer
 * cannot choose channels, reach `ipcRenderer`, or send anything the contract
 * does not declare. Kept free of `electron` imports so the allowlist is
 * testable under plain Node.
 */
export function createPreloadApi(invoke: InvokeFunction): JobAgentApi {
  const api: Record<string, (request?: unknown) => Promise<unknown>> = {};
  for (const [channel, definition] of Object.entries(ipcChannels)) {
    api[definition.method] = async (request?: unknown) => {
      const envelope = await invoke(channel as IpcChannel, request ?? {});
      return unwrapEnvelope(envelope);
    };
  }
  return Object.freeze(api) as unknown as JobAgentApi;
}
