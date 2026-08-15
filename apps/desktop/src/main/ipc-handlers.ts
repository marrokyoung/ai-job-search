import {
  ipcChannelNames,
  ipcChannels,
  type IpcChannel,
  type IpcErrorCode,
  type IpcFailure,
} from "../shared/ipc-contract.ts";
import { IpcValidationError } from "../shared/validation.ts";
import { ServiceError, type DesktopServices } from "./services.ts";

export type IpcMainLike = {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void;
};

export type IpcRouterOptions = {
  /**
   * Rejects requests from unexpected frames. The Electron entrypoint wires
   * this to a check that the sending frame is the app's own renderer page.
   */
  isTrustedSender?: (event: unknown) => boolean;
  /** Receives internal errors for structured logging; never renderer-visible. */
  onInternalError?: (channel: IpcChannel, error: unknown) => void;
};

export type IpcRouter = {
  channels: readonly IpcChannel[];
  handle(channel: string, event: unknown, args: readonly unknown[]): Promise<unknown>;
};

function failure(code: IpcErrorCode, message: string): IpcFailure {
  return { ok: false, error: { code, message } };
}

/**
 * Validates every request before it reaches a service and every response
 * before it returns to the renderer. Unexpected errors are reduced to a fixed
 * message so internal details (paths, SQL, stack traces) never cross the
 * boundary.
 */
export function createIpcRouter(
  services: DesktopServices,
  options?: IpcRouterOptions,
): IpcRouter {
  const isTrustedSender = options?.isTrustedSender ?? (() => true);
  return {
    channels: ipcChannelNames,
    async handle(channel, event, args) {
      const definition = Object.hasOwn(ipcChannels, channel)
        ? ipcChannels[channel as IpcChannel]
        : undefined;
      if (!definition) {
        return failure("invalid_request", `Unknown IPC channel "${channel}".`);
      }
      if (!isTrustedSender(event)) {
        return failure("untrusted_sender", "The IPC request came from an untrusted sender.");
      }
      if (args.length > 1) {
        return failure("invalid_request", "IPC requests take exactly one payload argument.");
      }

      let request: unknown;
      try {
        const payload = args[0] === undefined ? {} : args[0];
        request = definition.request.parse(payload, "request");
      } catch (error) {
        return failure(
          "invalid_request",
          error instanceof IpcValidationError ? error.message : "Invalid request.",
        );
      }

      try {
        const service = services[definition.method] as (input: unknown) => unknown;
        const data = service(request);
        return { ok: true, data: definition.response.parse(data, "response") };
      } catch (error) {
        if (error instanceof ServiceError) {
          return failure(error.code, error.message);
        }
        options?.onInternalError?.(channel as IpcChannel, error);
        if (error instanceof IpcValidationError) {
          return failure("internal", "The response failed contract validation.");
        }
        return failure("internal", "An internal error occurred.");
      }
    },
  };
}

/** Registers exactly the contract's channels on ipcMain — nothing else. */
export function registerIpcHandlers(ipcMain: IpcMainLike, router: IpcRouter): void {
  for (const channel of router.channels) {
    ipcMain.handle(channel, (event, ...args) => router.handle(channel, event, args));
  }
}
