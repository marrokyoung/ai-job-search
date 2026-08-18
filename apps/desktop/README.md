# @us-job-agent/desktop

Electron shell for the US Job Agent (Phase 1C/1D). Provides the secure
main/preload/renderer boundary, typed runtime-validated IPC over the SQLite
repositories in `@us-job-agent/database`, and the React renderer with the
Dashboard, Jobs, Applications, Review Queue, and Settings routes. The renderer
talks only to the frozen `window.jobAgent` preload API — it has no Node,
filesystem, database, or Electron access — and is served under a strict CSP
via a small hash router (`src/renderer/router.ts`). Renderer tests
(`tests/renderer-*.test.ts`) run the real preload surface, IPC router, and a
real seeded SQLite database under happy-dom, so filters, review resolution,
settings updates, and pause persistence are exercised end to end without an
Electron process; the Electron smoke test then proves the same renderer works
inside the real shell.

## Security boundary

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
  (plus `app.enableSandbox()`), enforced in
  [src/main/window-config.ts](src/main/window-config.ts) and covered by tests.
- The preload script exposes exactly one frozen object, `window.jobAgent`,
  derived from the channel table in
  [src/shared/ipc-contract.ts](src/shared/ipc-contract.ts). No `ipcRenderer`,
  no generic `invoke(channel, …)`, no filesystem/shell/database access.
- Every IPC request and response is runtime-validated in the main process
  ([src/main/ipc-handlers.ts](src/main/ipc-handlers.ts)); strict object
  validation rejects unknown keys, unexpected errors are reduced to a fixed
  message, and requests from frames other than the app's own renderer page are
  refused.
- Runtime data (the SQLite database) resolves beneath Electron's
  `app.getPath("userData")` and is refused if it would land anywhere inside
  the enclosing repository checkout (detected by walking up to the outermost
  `.git`), with junction/symlink canonicalization on both sides that fails
  closed when a path cannot be canonicalized
  ([src/main/runtime-paths.ts](src/main/runtime-paths.ts)). Nothing private is
  stored in the repository.
- The main process opens SQLite through the constrained
  `@us-job-agent/database/bundled` entry point, which reads the build-copied
  migrations and the Electron-ABI native module from `dist/`. The general
  `openDatabase` API has no migration or native-binding overrides; the
  versioned SQL in `packages/database/migrations/` stays authoritative.

## Commands

```powershell
bun run --filter @us-job-agent/desktop test       # boundary tests (plain Node, no Electron needed)
bun run --filter @us-job-agent/desktop typecheck
bun run --filter @us-job-agent/desktop build      # bundle main/preload/renderer into dist/
bun run --filter @us-job-agent/desktop start      # build then launch Electron
```

## Development-run notes (until Phase 1E packaging)

- `bun install` does not run dependency lifecycle scripts unless bun trusts
  them, and this repo deliberately forbids `trustedDependencies`
  (see `tools/security_guards.py`). If `apps/desktop/node_modules/electron/dist`
  is missing after install, fetch the Electron binary once with:
  `node apps/desktop/node_modules/electron/install.js` (run from the repo root)
- `better-sqlite3` needs a separate build for Electron's ABI. `bun run build`
  stages the matching prebuilt binary into `dist/native/better_sqlite3.node`
  automatically (downloaded once, then served from prebuild-install's cache);
  the host-Node build used by the test suite is left untouched. Because this
  download lives outside bun's lockfile, the fetched artifact is verified
  against a SHA-256 pin in [build.mjs](build.mjs) before it is bundled —
  adding a platform or bumping a version means auditing the artifact and
  updating the pin in the same diff. Electron is pinned to the **41.x** line
  because its ABI (v145) is the newest with published better-sqlite3 12.x
  prebuilds — bump the pin only together with a better-sqlite3 release that
  covers the new ABI. Phase 1E's packaging pipeline is expected to replace
  this staging with centrally produced, verified artifacts.
- The test suite includes a real Electron startup smoke test
  ([tests/electron-smoke.test.ts](tests/electron-smoke.test.ts)). It passes
  only when the renderer demonstrably received a validated settings response
  through the real preload/IPC bridge (main reads the rendered DOM back before
  printing the success marker). It skips (rather than fails) where the
  Electron binary has not been fetched; CI runs it for real in the
  `desktop-smoke` Windows job.
- In development the main process seeds the idempotent synthetic workspace on
  startup: four jobs covering every eligibility outcome (eligible with soft
  gaps, blocked, needs-review, unassessed), three applications progressed
  through validated transitions, and one open review item. Phase 1 never makes
  live network requests.
