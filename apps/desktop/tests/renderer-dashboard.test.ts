import "./helpers/register-dom.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { DesktopServices } from "../src/main/services.ts";
import { createHarness, resetRendererTestState } from "./helpers/renderer-harness.tsx";

afterEach(() => {
  resetRendererTestState();
});

describe("dashboard", () => {
  test("displays the synthetic database's state counts, reviews, pause status, and events", async () => {
    const harness = createHarness();
    harness.renderApp("#/dashboard");

    // State-count cards computed from the seeded applications.
    const states = await screen.findByRole("heading", { name: "Applications by state" });
    const stateSection = states.closest("section");
    assert.ok(stateSection);
    for (const label of ["shortlisted", "hard stopped", "needs review"]) {
      const card: HTMLElement | null = within(stateSection).getByText(label).closest("li");
      assert.ok(card, `a card exists for ${label}`);
      assert.match(card.textContent ?? "", /1/);
    }

    // Unresolved review items from the seeded open review item.
    screen.getByText("1 review item waiting for a decision.");

    // Pause indicator (settings seed defaults to paused).
    screen.getByText("Automation is paused.");

    // Synthetic-data banner.
    screen.getByText(/Synthetic data only — Phase 1 makes no live requests/);

    // Recent events from the immutable event log.
    const events = screen.getByRole("heading", { name: "Recent application events" });
    const eventSection = events.closest("section");
    assert.ok(eventSection);
    within(eventSection).getByText("Shortlisted by the synthetic user for tailoring.");
    within(eventSection).getByText(
      "Blocked: the mandatory CDL-A license is recorded as absent.",
    );
  });

  test("an empty database shows empty states instead of blank sections", async () => {
    const harness = createHarness({ seed: false });
    harness.renderApp("#/dashboard");

    await screen.findByText(
      "No applications yet. Discovered jobs will appear here once they are tracked.",
    );
    screen.getByText("No review items are waiting.");
    screen.getByText("No application events recorded yet.");
  });

  test("a failing metrics query shows an error state whose retry recovers", async () => {
    let failuresLeft = 1;
    const harness = createHarness({
      wrapServices: (services): DesktopServices => ({
        ...services,
        getDashboardMetrics(request) {
          if (failuresLeft > 0) {
            failuresLeft -= 1;
            throw new Error("Synthetic database failure.");
          }
          return services.getDashboardMetrics(request);
        },
      }),
    });
    harness.renderApp("#/dashboard");

    const alert = await screen.findByRole("alert");
    // Internal errors must reach the renderer as the fixed message, never raw details.
    assert.match(alert.textContent ?? "", /An internal error occurred\./);
    assert.doesNotMatch(alert.textContent ?? "", /Synthetic database failure/);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Applications by state" });
  });

  test("a pending metrics query shows a loading state", async () => {
    const harness = createHarness({
      patchApi: (api) => ({
        ...api,
        getDashboardMetrics: () => new Promise(() => {}),
      }),
    });
    harness.renderApp("#/dashboard");

    await waitFor(() => {
      const status = screen.getByText("Loading dashboard metrics…");
      assert.equal(status.getAttribute("role"), "status");
    });
  });
});
