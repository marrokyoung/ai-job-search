import "./helpers/register-dom.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createHarness, resetRendererTestState } from "./helpers/renderer-harness.tsx";

afterEach(() => {
  resetRendererTestState();
});

function rowTitles(): string[] {
  const table = screen.getByRole("table", {
    name: "Tracked jobs with their latest eligibility assessment",
  });
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("rowheader")[0]?.textContent ?? "");
}

describe("jobs route", () => {
  test("lists every seeded job with eligibility badges and soft-gap counts", async () => {
    const harness = createHarness();
    harness.renderApp("#/jobs");

    await screen.findByRole("heading", { level: 1, name: "Jobs" });
    await waitFor(() => assert.equal(rowTitles().length, 4));

    const automotiveRow = screen
      .getByRole("link", { name: "Automotive Systems Engineer" })
      .closest("tr");
    assert.ok(automotiveRow);
    within(automotiveRow).getByText("eligible");
    within(automotiveRow).getByText("2"); // soft-gap count from the two seeded soft gaps

    const driverRow = screen
      .getByRole("link", { name: "Commercial Delivery Driver" })
      .closest("tr");
    assert.ok(driverRow);
    within(driverRow).getByText("blocked");

    const unassessedRow = screen
      .getByRole("link", { name: "Manufacturing Process Engineer" })
      .closest("tr");
    assert.ok(unassessedRow);
    within(unassessedRow).getByText("not assessed");
  });

  test("the eligibility filter narrows the table through the IPC boundary", async () => {
    const harness = createHarness();
    harness.renderApp("#/jobs");
    await waitFor(() => assert.equal(rowTitles().length, 4));

    const filter = screen.getByLabelText("Eligibility filter");
    fireEvent.change(filter, { target: { value: "eligible" } });
    await waitFor(() => assert.deepEqual(rowTitles(), ["Automotive Systems Engineer"]));

    fireEvent.change(filter, { target: { value: "blocked" } });
    await waitFor(() => assert.deepEqual(rowTitles(), ["Commercial Delivery Driver"]));

    fireEvent.change(filter, { target: { value: "needs_review" } });
    await waitFor(() => assert.deepEqual(rowTitles(), ["Field Service Technician"]));

    fireEvent.change(filter, { target: { value: "all" } });
    await waitFor(() => assert.equal(rowTitles().length, 4));
  });

  test("column sorting is keyboard-operable and announces direction via aria-sort", async () => {
    const harness = createHarness();
    harness.renderApp("#/jobs");
    await waitFor(() => assert.equal(rowTitles().length, 4));

    const titleSort = screen.getByRole("button", { name: "Title" });
    fireEvent.click(titleSort);
    await waitFor(() =>
      assert.deepEqual(rowTitles(), [
        "Automotive Systems Engineer",
        "Commercial Delivery Driver",
        "Field Service Technician",
        "Manufacturing Process Engineer",
      ]),
    );
    assert.equal(titleSort.closest("th")?.getAttribute("aria-sort"), "ascending");

    fireEvent.click(titleSort);
    await waitFor(() =>
      assert.deepEqual(rowTitles(), [
        "Manufacturing Process Engineer",
        "Field Service Technician",
        "Commercial Delivery Driver",
        "Automotive Systems Engineer",
      ]),
    );
    assert.equal(titleSort.closest("th")?.getAttribute("aria-sort"), "descending");
  });

  test("the job drawer shows assessments, closes on Escape, and restores focus", async () => {
    const harness = createHarness();
    harness.renderApp("#/jobs");
    await waitFor(() => assert.equal(rowTitles().length, 4));

    const jobLink = screen.getByRole("link", { name: "Automotive Systems Engineer" });
    // A keyboard user focuses the link before activating it; clicks in
    // happy-dom do not move focus the way a real browser does.
    jobLink.focus();
    fireEvent.click(jobLink);

    const drawer = await screen.findByRole("dialog", { name: "Job detail" });
    await waitFor(() => {
      assert.ok(
        document.activeElement === within(drawer).getByRole("button", { name: "Close" }),
        "focus moves to the drawer's close button",
      );
    });

    // Assessments for the pinned snapshot, including severity and explanation.
    await within(drawer).findByText("Five or more years of automotive systems experience.");
    within(drawer).getByText("Industry-experience gaps are soft by policy and never block.");
    within(drawer).getByText(/2 soft gaps/);
    within(drawer).getByText(/Synthetic automotive systems role/);
    within(drawer).getByText(/Evidence excerpts will appear here/);

    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => {
      assert.ok(
        screen.queryByRole("dialog", { name: "Job detail" }) === null,
        "the drawer closes on Escape",
      );
    });
    assert.equal(window.location.hash, "#/jobs");
    assert.ok(document.activeElement === jobLink, "focus returns to the opening link");
  });

  test("a job drawer for an unknown id shows a not-found state", async () => {
    const harness = createHarness();
    harness.renderApp("#/jobs/not-a-real-job");

    const drawer = await screen.findByRole("dialog", { name: "Job detail" });
    await within(drawer).findByText(/Not found\./);
  });
});
