import "./helpers/register-dom.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../src/renderer/app.tsx";
import { createHarness, resetRendererTestState } from "./helpers/renderer-harness.tsx";

afterEach(() => {
  resetRendererTestState();
});

describe("renderer routing and shell", () => {
  test("every primary route renders behind the shared navigation", async () => {
    const harness = createHarness();
    harness.renderApp();

    await screen.findByRole("heading", { level: 1, name: "Dashboard" });

    const routes = [
      { link: "Jobs", heading: "Jobs" },
      { link: "Applications", heading: "Applications" },
      { link: "Review queue", heading: "Review queue" },
      { link: "Settings", heading: "Settings" },
      { link: "Dashboard", heading: "Dashboard" },
    ];
    const navigation = screen.getByRole("navigation", { name: "Primary" });
    for (const route of routes) {
      fireEvent.click(screen.getByRole("link", { name: route.link }));
      await screen.findByRole("heading", { level: 1, name: route.heading });
      const active = navigation.querySelector('[aria-current="page"]');
      assert.equal(active?.textContent, route.link, "the active nav link tracks the route");
    }
  });

  test("an unknown route shows a not-found page that links back to the dashboard", async () => {
    const harness = createHarness();
    harness.renderApp("#/no-such-page/at-all");

    await screen.findByRole("heading", { level: 1, name: "Page not found" });
    fireEvent.click(screen.getByRole("link", { name: "Go to the dashboard" }));
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
  });

  test("malformed percent-encoding in a route shows not-found instead of crashing", async () => {
    const harness = createHarness();
    // "%" is invalid percent-encoding: decodeURIComponent throws URIError.
    harness.renderApp("#/jobs/%");

    await screen.findByRole("heading", { level: 1, name: "Page not found" });

    // The applications detail route is guarded the same way.
    fireEvent.click(screen.getByRole("link", { name: "Go to the dashboard" }));
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    window.location.hash = "#/applications/%E0%A4%A";
    fireEvent(window, new window.Event("hashchange"));
    await screen.findByRole("heading", { level: 1, name: "Page not found" });
  });

  test("a missing preload bridge renders an explicit failure, not a blank page", () => {
    delete window.jobAgent;
    window.location.hash = "#/dashboard";
    render(createElement(App));

    screen.getByRole("alert");
    assert.equal(
      document.getElementById("bridge-status")?.textContent,
      "unavailable — preload bridge missing",
    );
    assert.equal(document.getElementById("automation-status")?.textContent, "unknown");
    assert.equal(document.getElementById("data-directory")?.textContent, "unknown");
  });

  test("the shell exposes the smoke-test status region once settings load", async () => {
    const harness = createHarness();
    harness.renderApp();

    await waitFor(() => {
      assert.match(
        document.getElementById("bridge-status")?.textContent ?? "",
        /^available \(\d+ methods, frozen: true\)$/,
      );
      assert.equal(document.getElementById("automation-status")?.textContent, "paused");
      assert.equal(
        document.getElementById("data-directory")?.textContent,
        harness.dataDirectory,
      );
    });
  });

  test("the skip link moves focus to the main landmark", async () => {
    const harness = createHarness();
    harness.renderApp();
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });

    const skipLink = screen.getByRole("link", { name: "Skip to main content" });
    skipLink.focus();
    assert.ok(document.activeElement === skipLink, "the skip link is focusable");
    fireEvent.click(skipLink);
    assert.ok(
      document.activeElement === screen.getByRole("main"),
      "activating the skip link focuses the main landmark",
    );
  });
});
