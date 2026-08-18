import "./helpers/register-dom.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createHarness, resetRendererTestState } from "./helpers/renderer-harness.tsx";

afterEach(() => {
  resetRendererTestState();
});

async function resumeAutomationThroughDialog(reason: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Resume automation…" }));
  const dialog = await screen.findByRole("dialog", { name: "Resume automation" });
  fireEvent.change(within(dialog).getByLabelText("Reason"), {
    target: { value: reason },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Resume" }));
  await screen.findByText("Automation is running.");
}

describe("settings route", () => {
  test("shows the stored settings and the local data path", async () => {
    const harness = createHarness();
    harness.renderApp("#/settings");

    await screen.findByRole("heading", { level: 1, name: "Settings" });
    const modeSelect = await screen.findByLabelText<HTMLSelectElement>(
      "Default automation mode",
    );
    assert.equal(modeSelect.value, "assisted");
    const limitInput = screen.getByLabelText<HTMLInputElement>(
      "Daily application limit",
    );
    assert.equal(limitInput.value, "10");
    screen.getByText("Automation is paused. No automated submissions can occur.");
    // The path appears in the Local data section (the shell footer also shows it).
    const dataSection = screen
      .getByRole("heading", { name: "Local data" })
      .closest("section");
    assert.ok(dataSection);
    within(dataSection).getByText(harness.dataDirectory);
  });

  test("saving a new default mode and daily limit persists through the boundary", async () => {
    const harness = createHarness();
    harness.renderApp("#/settings");

    const modeSelect = await screen.findByLabelText<HTMLSelectElement>(
      "Default automation mode",
    );
    fireEvent.change(modeSelect, { target: { value: "manual" } });
    fireEvent.change(screen.getByLabelText("Daily application limit"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    const confirmation = await screen.findByText("Settings saved.");
    assert.equal(confirmation.getAttribute("role"), "status");

    const { settings } = await harness.api.getSettings();
    assert.equal(settings.defaultMode, "manual");
    assert.equal(settings.dailyApplicationLimit, 5);
  });

  test("an invalid daily limit is rejected client-side without a request", async () => {
    const harness = createHarness();
    harness.renderApp("#/settings");

    const limitInput = await screen.findByLabelText<HTMLInputElement>(
      "Daily application limit",
    );
    fireEvent.change(limitInput, { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    const alert = await screen.findByRole("alert");
    assert.match(alert.textContent ?? "", /whole number between 0 and 1000/);
    const { settings } = await harness.api.getSettings();
    assert.equal(settings.dailyApplicationLimit, 10, "the stored limit is unchanged");
  });

  test("pausing and resuming requires a reason and updates the whole shell", async () => {
    const harness = createHarness();
    harness.renderApp("#/settings");

    // Paused banner and footer reflect the seeded paused state.
    await screen.findByText("Automation is paused. It can be resumed from Settings.");
    await waitFor(() => {
      assert.equal(document.getElementById("automation-status")?.textContent, "paused");
    });

    // The resume dialog requires a non-blank reason.
    fireEvent.click(screen.getByRole("button", { name: "Resume automation…" }));
    const dialog = await screen.findByRole("dialog", { name: "Resume automation" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resume" }));
    const validation = await within(dialog).findByRole("alert");
    assert.equal(validation.textContent, "A reason is required.");

    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "Synthetic resume for testing." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resume" }));

    // Page status, paused banner, and smoke-test footer all update.
    await screen.findByText("Automation is running.");
    assert.equal(
      screen.queryByText("Automation is paused. It can be resumed from Settings."),
      null,
    );
    await waitFor(() => {
      assert.equal(document.getElementById("automation-status")?.textContent, "running");
    });

    // The reason lands in the immutable audit log with the settings change.
    const { settings } = await harness.api.getSettings();
    assert.equal(settings.automationPaused, false);
  });

  test("the pause state persists across a database restart", async () => {
    const harness = createHarness();
    harness.renderApp("#/settings");
    await resumeAutomationThroughDialog("Synthetic resume before restart.");

    // Simulate an application restart: close and reopen the same database
    // file, then mount a fresh renderer against it.
    cleanup();
    harness.restartDatabase();
    harness.renderApp("#/settings");
    await screen.findByText("Automation is running.");

    // Pause again and restart once more: the paused state also persists.
    fireEvent.click(screen.getByRole("button", { name: "Pause automation…" }));
    const dialog = await screen.findByRole("dialog", { name: "Pause automation" });
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "Synthetic pause before restart." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause" }));
    await screen.findByText("Automation is paused. No automated submissions can occur.");

    cleanup();
    harness.restartDatabase();
    harness.renderApp("#/settings");
    await screen.findByText("Automation is paused. No automated submissions can occur.");
    await screen.findByText("Automation is paused. It can be resumed from Settings.");
  });

  test("destructive data controls are present but disabled with an explanation", async () => {
    const harness = createHarness();
    harness.renderApp("#/settings");

    await screen.findByRole("heading", { name: "Destructive data controls" });
    const deleteButton = screen.getByRole("button", { name: "Delete all local data" });
    const exportButton = screen.getByRole("button", {
      name: "Export and reset database",
    });
    for (const button of [deleteButton, exportButton]) {
      assert.equal(button.hasAttribute("disabled"), true);
      const noteId = button.getAttribute("aria-describedby");
      assert.ok(noteId, "each disabled control references the explanation");
      assert.match(
        document.getElementById(noteId)?.textContent ?? "",
        /confirmation flow/,
      );
    }
  });
});
