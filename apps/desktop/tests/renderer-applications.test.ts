import "./helpers/register-dom.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ApplicationRepository } from "@us-job-agent/database";
import { latestFailure } from "../src/renderer/pages/applications.tsx";
import { createHarness, resetRendererTestState } from "./helpers/renderer-harness.tsx";

afterEach(() => {
  resetRendererTestState();
});

function applicationRows(): string[] {
  const table = screen.getByRole("table", {
    name: "Tracked applications and their current lifecycle state",
  });
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("rowheader")[0]?.textContent ?? "");
}

describe("applications route", () => {
  test("lists applications and filters them by state", async () => {
    const harness = createHarness();
    harness.renderApp("#/applications");

    await screen.findByRole("heading", { level: 1, name: "Applications" });
    await waitFor(() => assert.equal(applicationRows().length, 3));

    const filter = screen.getByLabelText("State filter");
    fireEvent.change(filter, { target: { value: "shortlisted" } });
    await waitFor(() =>
      assert.deepEqual(applicationRows(), ["Automotive Systems Engineer"]),
    );

    fireEvent.change(filter, { target: { value: "submitted" } });
    await screen.findByText('No applications are in the "submitted" state.');
  });

  test("application detail shows state, automation mode, and the immutable timeline", async () => {
    const harness = createHarness();
    harness.renderApp("#/applications");
    await waitFor(() => assert.equal(applicationRows().length, 3));

    fireEvent.click(screen.getByRole("link", { name: "Automotive Systems Engineer" }));
    await screen.findByRole("heading", {
      level: 1,
      name: "Automotive Systems Engineer — Example Mobility Labs",
    });

    // Automation mode and current state are visible.
    screen.getByText("assisted");
    const stateDefinition = screen.getByText("Current state").closest("div");
    assert.ok(stateDefinition);
    within(stateDefinition).getByText("shortlisted");

    // The append-only timeline renders every event in order with reasons.
    screen.getByText(/Events are append-only/);
    const timeline = screen.getByRole("heading", { name: "Timeline" }).closest("section");
    assert.ok(timeline);
    const items = within(timeline).getAllByRole("listitem");
    assert.equal(items.length, 4);
    assert.match(items[0]?.textContent ?? "", /#1.*application created/s);
    assert.match(items[1]?.textContent ?? "", /Synthetic posting normalized\./s);
    assert.match(items[2]?.textContent ?? "", /Eligible: experience gaps are soft gaps by policy\./s);
    assert.match(items[3]?.textContent ?? "", /#4.*Shortlisted by the synthetic user/s);

    // No failures recorded for this application.
    screen.getByText("No failures recorded for this application.");
  });

  test("the latest recorded failure is surfaced on the detail page", async () => {
    const harness = createHarness();
    assert.ok(harness.seeded);
    // Drive the seeded shortlisted application into a real verification
    // failure through the repository (the same path the app will use).
    const applications = new ApplicationRepository(harness.database());
    const authorization = {
      automationMode: "assisted",
      actor: "system",
      verification: { result: "not_run" },
      sourceSubmissionAllowed: false,
      globalAutomationPaused: true,
    } as const;
    applications.transition({
      applicationId: harness.seeded.applicationId,
      command: { from: "shortlisted", to: "preparing", authorization },
      reason: "Synthetic preparation started.",
      now: "2026-01-09T09:00:00.000Z",
    });
    applications.transition({
      applicationId: harness.seeded.applicationId,
      command: { from: "preparing", to: "verification_failed", authorization },
      reason: "Synthetic answer verification found an unsupported claim.",
      now: "2026-01-09T10:00:00.000Z",
    });

    harness.renderApp(`#/applications/${harness.seeded.applicationId}`);
    const failureAlert = await screen.findByRole("alert");
    assert.match(
      failureAlert.textContent ?? "",
      /verification failed at 2026-01-09 10:00 UTC: Synthetic answer verification found an unsupported claim\./,
    );
  });

  test("latestFailure picks the most recent failure event only", () => {
    const event = (sequenceNumber: number, toState: string) => ({
      eventId: `event-${sequenceNumber}`,
      applicationId: "application-1",
      sequenceNumber,
      eventType: "state_transition",
      actor: "system" as const,
      fromState: null,
      toState: toState as never,
      occurredAt: "2026-01-01T00:00:00.000Z",
      reason: "",
      correlationId: null,
      supersedesEventId: null,
    });
    assert.equal(latestFailure([event(1, "discovered"), event(2, "normalized")]), null);
    const events = [
      event(1, "verification_failed"),
      event(2, "preparing"),
      event(3, "submission_failed"),
      event(4, "submitting"),
    ];
    assert.equal(latestFailure(events)?.sequenceNumber, 3);
  });

  test("an unknown application id shows a not-found state", async () => {
    const harness = createHarness();
    harness.renderApp("#/applications/not-a-real-application");
    await screen.findByText(/Not found\./);
  });
});
