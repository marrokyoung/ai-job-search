import "./helpers/register-dom.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createHarness, resetRendererTestState } from "./helpers/renderer-harness.tsx";

afterEach(() => {
  resetRendererTestState();
});

const seededSummary =
  "Confirm whether the synthetic candidate holds a state electrical license; the posting may require one.";

describe("review queue", () => {
  test("lists open items and refuses to resolve without a reason", async () => {
    const harness = createHarness();
    harness.renderApp("#/reviews");

    await screen.findByText(seededSummary);
    fireEvent.click(screen.getByRole("button", { name: "Resolve…" }));

    const dialog = await screen.findByRole("dialog", { name: "Resolve review item" });
    const reasonField = within(dialog).getByLabelText("Reason");
    await waitFor(() => {
      assert.ok(
        document.activeElement === reasonField,
        "focus moves to the reason field when the dialog opens",
      );
    });

    // Submitting with a blank reason is rejected client-side with an alert.
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve" }));
    const validation = await within(dialog).findByRole("alert");
    assert.equal(validation.textContent, "A reason is required.");
    assert.equal(reasonField.getAttribute("aria-invalid"), "true");

    // Whitespace only is still blank.
    fireEvent.change(reasonField, { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve" }));
    await within(dialog).findByRole("alert");

    // The item is still open server-side.
    const { reviewItems } = await harness.api.listReviewItems({ status: "open" });
    assert.equal(reviewItems.length, 1);
  });

  test("resolving with a reason persists the reason and empties the queue", async () => {
    const harness = createHarness();
    harness.renderApp("#/reviews");

    await screen.findByText(seededSummary);
    // The page discloses that a decision here does not change any
    // application's state — the needs-review hold is cleared only by a
    // re-evaluation with verified candidate facts (a later phase).
    screen.getByText(/does not change any application's state/);

    fireEvent.click(screen.getByRole("button", { name: "Resolve…" }));
    const dialog = await screen.findByRole("dialog", { name: "Resolve review item" });
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "License verified with the synthetic candidate." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve" }));

    // The open queue empties.
    await screen.findByText(
      "The review queue is empty. Nothing is waiting on a decision.",
    );

    // The reason is persisted and visible under the resolved filter.
    fireEvent.change(screen.getByLabelText("Status filter"), {
      target: { value: "resolved" },
    });
    await screen.findByText(/License verified with the synthetic candidate\./);

    const { reviewItems } = await harness.api.listReviewItems({ status: "resolved" });
    assert.equal(reviewItems.length, 1);
    assert.equal(
      reviewItems[0]?.resolutionReason,
      "License verified with the synthetic candidate.",
    );

    // Resolving the review item is a queue decision only: the linked
    // application deliberately remains held in needs_review, because clearing
    // it requires verified candidate facts (fail-closed until that ledger
    // exists).
    const { applications } = await harness.api.listApplications({
      state: "needs_review",
    });
    assert.equal(applications.length, 1);
    assert.equal(applications[0]?.jobTitle, "Field Service Technician");
  });

  test("dismissing captures its own reason and persists the dismissed status", async () => {
    const harness = createHarness();
    harness.renderApp("#/reviews");

    await screen.findByText(seededSummary);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss…" }));
    const dialog = await screen.findByRole("dialog", { name: "Dismiss review item" });
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "Not pursuing this synthetic role." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));

    await screen.findByText(
      "The review queue is empty. Nothing is waiting on a decision.",
    );
    const { reviewItems } = await harness.api.listReviewItems({ status: "dismissed" });
    assert.equal(reviewItems.length, 1);
    assert.equal(reviewItems[0]?.resolutionReason, "Not pursuing this synthetic role.");
  });

  test("the dialog traps Tab focus, closes on Escape, and restores focus", async () => {
    const harness = createHarness();
    harness.renderApp("#/reviews");

    await screen.findByText(seededSummary);
    const openButton = screen.getByRole("button", { name: "Resolve…" });
    // A keyboard user reaches the button before activating it; clicks in
    // happy-dom do not move focus the way a real browser does.
    openButton.focus();
    fireEvent.click(openButton);
    const dialog = await screen.findByRole("dialog", { name: "Resolve review item" });
    assert.equal(dialog.getAttribute("aria-modal"), "true");

    const reasonField = within(dialog).getByLabelText("Reason");
    const submitButton = within(dialog).getByRole("button", { name: "Resolve" });

    // Tab from the last focusable element wraps to the first.
    submitButton.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    assert.ok(document.activeElement === reasonField, "Tab wraps to the reason field");

    // Shift+Tab from the first wraps back to the last.
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    assert.ok(document.activeElement === submitButton, "Shift+Tab wraps to the submit button");

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      assert.ok(
        screen.queryByRole("dialog", { name: "Resolve review item" }) === null,
        "the dialog closes on Escape",
      );
    });
    assert.ok(document.activeElement === openButton, "focus returns to the trigger");

    // Nothing was resolved by cancelling.
    const { reviewItems } = await harness.api.listReviewItems({ status: "open" });
    assert.equal(reviewItems.length, 1);
  });
});
