import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  openDatabase,
  seedSyntheticData,
  type JobAgentDatabase,
} from "@us-job-agent/database";
import {
  createIpcRouter,
  registerIpcHandlers,
  type IpcMainLike,
} from "../src/main/ipc-handlers.ts";
import { createDesktopServices, type DesktopServices } from "../src/main/services.ts";
import { ipcChannelNames } from "../src/shared/ipc-contract.ts";

type Envelope = {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
};

const trustedEvent = { sender: "renderer" };
const openDatabases: JobAgentDatabase[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function createFixture() {
  const database = openDatabase({ filename: ":memory:" });
  openDatabases.push(database);
  const seeded = seedSyntheticData(database);
  const services = createDesktopServices({
    getDatabase: () => database,
    dataDirectory: "C:\\synthetic\\user-data\\data",
  });
  const router = createIpcRouter(services, {
    isTrustedSender: (event) => event === trustedEvent,
  });
  const call = (channel: string, payload?: unknown, event: unknown = trustedEvent) =>
    router.handle(channel, event, payload === undefined ? [] : [payload]) as Promise<Envelope>;
  return { database, seeded, services, router, call };
}

function expectFailure(envelope: Envelope, code: string): void {
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, code);
}

describe("IPC request validation", () => {
  test("rejects non-object, array, and extra-argument payloads on every channel", async () => {
    const { router } = createFixture();
    for (const channel of ipcChannelNames) {
      for (const payload of [42, "text", [], null]) {
        const envelope = (await router.handle(channel, trustedEvent, [payload])) as Envelope;
        expectFailure(envelope, "invalid_request");
      }
      const tooManyArguments = (await router.handle(channel, trustedEvent, [{}, {}])) as Envelope;
      expectFailure(tooManyArguments, "invalid_request");
    }
  });

  test("rejects unknown keys, wrong types, and out-of-range values", async () => {
    const { call } = createFixture();
    expectFailure(await call("jobs:list", { eligibility: "eligible", surprise: 1 }), "invalid_request");
    expectFailure(await call("jobs:list", { eligibility: "great" }), "invalid_request");
    expectFailure(await call("jobs:list", { limit: 0 }), "invalid_request");
    expectFailure(await call("jobs:list", { limit: 10_000 }), "invalid_request");
    expectFailure(await call("jobs:get", {}), "invalid_request");
    expectFailure(await call("jobs:get", { jobId: "   " }), "invalid_request");
    expectFailure(await call("applications:list", { state: "imaginary" }), "invalid_request");
    expectFailure(
      await call("automation:setPaused", { paused: "yes", reason: "r" }),
      "invalid_request",
    );
    expectFailure(await call("automation:setPaused", { paused: true, reason: " " }), "invalid_request");
    expectFailure(await call("settings:update", {}), "invalid_request");
    expectFailure(
      await call("settings:update", { dailyApplicationLimit: -2 }),
      "invalid_request",
    );
  });

  test("rejects a review item that names zero or two subjects", async () => {
    const { call, seeded } = createFixture();
    expectFailure(
      await call("reviews:create", { reviewType: "diagnostic", summary: "No subject." }),
      "invalid_request",
    );
    expectFailure(
      await call("reviews:create", {
        applicationId: seeded.applicationId,
        eligibilityAssessmentId: "assessment-1",
        reviewType: "diagnostic",
        summary: "Two subjects.",
      }),
      "invalid_request",
    );
  });

  test("rejects unknown channels", async () => {
    const { call } = createFixture();
    expectFailure(await call("app:evil", {}), "invalid_request");
    expectFailure(await call("jobs:list';DROP TABLE jobs;--", {}), "invalid_request");
  });
});

describe("IPC sender trust", () => {
  test("refuses requests from untrusted senders without touching services", async () => {
    const { call } = createFixture();
    const attack = await call(
      "automation:setPaused",
      { paused: false, reason: "attacker" },
      { sender: "somewhere-else" },
    );
    expectFailure(attack, "untrusted_sender");

    const settings = await call("settings:get", {});
    assert.equal(settings.ok, true);
    const data = settings.data as { settings: { automationPaused: boolean } };
    assert.equal(data.settings.automationPaused, true, "pause state must be unchanged");
  });
});

describe("IPC responses", () => {
  test("serves validated data for every read channel against seeded synthetic data", async () => {
    const { call, seeded } = createFixture();

    const metrics = await call("dashboard:getMetrics", {});
    assert.equal(metrics.ok, true);
    const metricsData = metrics.data as {
      applicationStateCounts: Array<{ state: string; count: number }>;
      automationPaused: boolean;
    };
    assert.deepEqual(metricsData.applicationStateCounts, [
      { state: "hard_stopped", count: 1 },
      { state: "needs_review", count: 1 },
      { state: "shortlisted", count: 1 },
    ]);
    assert.equal(metricsData.automationPaused, true);

    const jobs = await call("jobs:list", {});
    assert.equal(jobs.ok, true);
    const jobsData = jobs.data as { jobs: Array<{ jobId: string; title: string }> };
    assert.equal(jobsData.jobs.length, 4);
    assert.ok(jobsData.jobs.some((job) => job.jobId === seeded.jobId));

    const detail = await call("jobs:get", { jobId: seeded.jobId });
    assert.equal(detail.ok, true);
    const detailData = detail.data as { detail: { descriptionText: string } };
    assert.match(detailData.detail.descriptionText, /Synthetic automotive/);

    const application = await call("applications:get", {
      applicationId: seeded.applicationId,
    });
    assert.equal(application.ok, true);
    const applicationData = application.data as {
      detail: {
        application: { applicationId: string; currentState: string };
        jobSnapshotId: string;
        latestEvent: { eventType: string };
      };
    };
    assert.equal(applicationData.detail.application.applicationId, seeded.applicationId);
    assert.equal(applicationData.detail.application.currentState, "shortlisted");
    assert.equal(applicationData.detail.latestEvent.eventType, "state_transition");
    assert.ok(applicationData.detail.jobSnapshotId);

    const timeline = await call("applications:getTimeline", {
      applicationId: seeded.applicationId,
    });
    assert.equal(timeline.ok, true);
    const timelineData = timeline.data as { events: Array<{ eventType: string }> };
    assert.equal(timelineData.events[0]?.eventType, "application_created");
  });

  test("returns not_found for unknown jobs and applications", async () => {
    const { call } = createFixture();
    expectFailure(await call("jobs:get", { jobId: "missing-job" }), "not_found");
    expectFailure(
      await call("applications:get", { applicationId: "missing-application" }),
      "not_found",
    );
    expectFailure(
      await call("applications:getTimeline", { applicationId: "missing-application" }),
      "not_found",
    );
  });

  test("runs the review lifecycle and reports conflict on double resolution", async () => {
    const { call, seeded } = createFixture();
    const created = await call("reviews:create", {
      applicationId: seeded.applicationId,
      reviewType: "unknown_requirement",
      summary: "Synthetic review item.",
    });
    assert.equal(created.ok, true);
    const { reviewItemId } = created.data as { reviewItemId: string };

    // The synthetic seed already contains one open review item.
    const listed = await call("reviews:list", { status: "open" });
    assert.equal(listed.ok, true);
    assert.equal((listed.data as { reviewItems: unknown[] }).reviewItems.length, 2);

    const resolved = await call("reviews:resolve", {
      reviewItemId,
      outcome: "resolved",
      reason: "Synthetic resolution.",
    });
    assert.equal(resolved.ok, true);

    expectFailure(
      await call("reviews:resolve", {
        reviewItemId,
        outcome: "dismissed",
        reason: "Again.",
      }),
      "conflict",
    );
    expectFailure(
      await call("reviews:resolve", {
        reviewItemId: "missing-review",
        outcome: "resolved",
        reason: "Missing.",
      }),
      "not_found",
    );
  });

  test("updates settings and pause state through validated responses", async () => {
    const { call } = createFixture();
    const updated = await call("settings:update", { dailyApplicationLimit: 3 });
    assert.equal(updated.ok, true);
    const updatedData = updated.data as {
      settings: { dailyApplicationLimit: number; dataDirectory: string };
    };
    assert.equal(updatedData.settings.dailyApplicationLimit, 3);
    assert.equal(updatedData.settings.dataDirectory, "C:\\synthetic\\user-data\\data");

    const resumed = await call("automation:setPaused", {
      paused: false,
      reason: "Synthetic resume for testing.",
    });
    assert.equal(resumed.ok, true);
    assert.equal(
      (resumed.data as { settings: { automationPaused: boolean } }).settings.automationPaused,
      false,
    );
  });

  test("a response violating the contract is replaced by a fixed internal error", async () => {
    const { services } = createFixture();
    const internalErrors: unknown[] = [];
    const corrupted: DesktopServices = {
      ...services,
      getSettings: () =>
        ({ settings: { secretPath: "C:\\Users\\real-user" } }) as never,
    };
    const router = createIpcRouter(corrupted, {
      onInternalError: (_channel, error) => internalErrors.push(error),
    });
    const envelope = (await router.handle("settings:get", trustedEvent, [{}])) as Envelope;
    expectFailure(envelope, "internal");
    assert.equal(envelope.error?.message, "The response failed contract validation.");
    assert.equal(envelope.error?.message.includes("secretPath"), false);
    assert.equal(internalErrors.length, 1);
  });

  test("unexpected service errors never leak details to the renderer", async () => {
    const { services } = createFixture();
    const throwing: DesktopServices = {
      ...services,
      getDashboardMetrics: () => {
        throw new Error("SQLITE_ERROR near C:\\Users\\real-user\\job-agent.sqlite3");
      },
    };
    const router = createIpcRouter(throwing);
    const envelope = (await router.handle(
      "dashboard:getMetrics",
      trustedEvent,
      [{}],
    )) as Envelope;
    expectFailure(envelope, "internal");
    assert.equal(envelope.error?.message, "An internal error occurred.");
  });
});

describe("IPC handler registration", () => {
  test("registers exactly the contract channels on ipcMain", () => {
    const { router } = createFixture();
    const registered: string[] = [];
    const fakeIpcMain: IpcMainLike = {
      handle: (channel) => registered.push(channel),
    };
    registerIpcHandlers(fakeIpcMain, router);
    assert.deepEqual(registered.sort(), [...ipcChannelNames].sort());
  });
});
