import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMainWindowOptions } from "../src/main/window-config.ts";

describe("main window security configuration", () => {
  test("locks down the renderer web preferences", () => {
    const options = createMainWindowOptions({
      preloadScriptPath: "C:\\app\\dist\\preload.cjs",
    });
    const preferences = options.webPreferences;
    assert.ok(preferences);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.nodeIntegrationInWorker, false);
    assert.equal(preferences.nodeIntegrationInSubFrames, false);
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.webSecurity, true);
    assert.equal(preferences.allowRunningInsecureContent, false);
    assert.equal(preferences.experimentalFeatures, false);
    assert.equal(preferences.webviewTag, false);
    assert.equal(preferences.preload, "C:\\app\\dist\\preload.cjs");
  });
});
