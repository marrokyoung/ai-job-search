import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPreloadApi } from "../src/preload/create-preload-api.ts";
import { ipcChannels } from "../src/shared/ipc-contract.ts";

const contractMethods = Object.values(ipcChannels)
  .map((definition) => definition.method)
  .sort();

function recordingInvoke(result: unknown = { ok: true, data: null }) {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const invoke = (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    return Promise.resolve(result);
  };
  return { calls, invoke };
}

describe("preload API allowlist", () => {
  test("exposes exactly the documented contract methods and nothing else", () => {
    const { invoke } = recordingInvoke();
    const api = createPreloadApi(invoke) as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(api).sort(), contractMethods);
    for (const method of contractMethods) {
      assert.equal(typeof api[method], "function", `${method} must be a function`);
    }
  });

  test("exposes no raw IPC, filesystem, shell, or generic invoke escape hatch", () => {
    const { invoke } = recordingInvoke();
    const api = createPreloadApi(invoke) as unknown as Record<string, unknown>;
    for (const forbidden of [
      "invoke",
      "send",
      "sendSync",
      "on",
      "once",
      "ipcRenderer",
      "require",
      "process",
      "shell",
      "fs",
      "database",
    ]) {
      assert.equal(forbidden in api, false, `API must not expose "${forbidden}"`);
    }
  });

  test("is frozen so the renderer cannot add or replace methods", () => {
    const { invoke } = recordingInvoke();
    const api = createPreloadApi(invoke) as unknown as Record<string, unknown>;
    assert.equal(Object.isFrozen(api), true);
    assert.throws(() => {
      "use strict";
      (api as Record<string, unknown>).extra = () => {};
    }, TypeError);
    assert.equal("extra" in api, false);
  });

  test("routes every method to its fixed allowlisted channel", async () => {
    const { calls, invoke } = recordingInvoke();
    const api = createPreloadApi(invoke);
    await api.listJobs({ limit: 5 });
    await api.getJob({ jobId: "job-1" });
    await api.getDashboardMetrics();
    assert.deepEqual(
      calls.map((call) => call.channel),
      ["jobs:list", "jobs:get", "dashboard:getMetrics"],
    );
    assert.deepEqual(calls[0]?.payload, { limit: 5 });
    assert.deepEqual(calls[2]?.payload, {});
  });

  test("cannot be steered to a different channel through arguments", async () => {
    const { calls, invoke } = recordingInvoke();
    const api = createPreloadApi(invoke);
    await api.listJobs({ channel: "app:evil" } as never);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.channel, "jobs:list");
    const contractChannels = new Set(Object.keys(ipcChannels));
    for (const call of calls) {
      assert.ok(contractChannels.has(call.channel));
    }
  });

  test("unwraps success envelopes and surfaces failure envelopes as errors", async () => {
    const okApi = createPreloadApi(() =>
      Promise.resolve({ ok: true, data: { jobs: [] } }),
    );
    assert.deepEqual(await okApi.listJobs(), { jobs: [] });

    const failureApi = createPreloadApi(() =>
      Promise.resolve({
        ok: false,
        error: { code: "not_found", message: "Job missing-job was not found." },
      }),
    );
    await assert.rejects(
      failureApi.getJob({ jobId: "missing-job" }),
      /not_found: Job missing-job was not found\./,
    );

    const malformedApi = createPreloadApi(() => Promise.resolve("nonsense"));
    await assert.rejects(malformedApi.getDashboardMetrics(), /Malformed IPC response/);
  });
});
