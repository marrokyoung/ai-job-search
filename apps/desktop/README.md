# @us-job-agent/desktop

Electron shell for the US Job Agent (Phase 1C/1D/1E). Provides the secure
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
bun run --filter @us-job-agent/desktop test         # boundary tests (plain Node, no Electron needed)
bun run --filter @us-job-agent/desktop typecheck
bun run --filter @us-job-agent/desktop build        # bundle main/preload/renderer into dist/
bun run --filter @us-job-agent/desktop start        # build then launch Electron
bun run --filter @us-job-agent/desktop package      # build the Windows installer into release/
bun run --filter @us-job-agent/desktop package:dir  # build the unpacked app (no installer) into release/win-unpacked/
```

## Install from a clean clone

```powershell
git clone <this repository>
cd ai-job-search
bun install --frozen-lockfile
node apps/desktop/node_modules/electron/install.js   # one-time: fetch the Electron binary (see below)
bun run --filter @us-job-agent/desktop start         # build and launch in development
```

`bun install` does not run dependency lifecycle scripts unless bun trusts them,
and this repo deliberately forbids `trustedDependencies`
(see `tools/security_guards.py`). Electron's binary is fetched by such a script,
so the one-time `electron/install.js` step above is required for local
development (`start`) and the real Electron smoke test. It is **not** required to
build the installer — `electron-builder` downloads its own pinned Electron.

## Packaging (Windows installer)

`bun run --filter @us-job-agent/desktop package` runs `build.mjs --package` and
then `electron-builder` (config in [electron-builder.yml](electron-builder.yml)),
producing under `release/`:

- `US Job Agent Setup <version>.exe` — the NSIS installer (the deliverable);
- `US Job Agent Setup <version>.exe.blockmap` — installer metadata;
- `win-unpacked/` — the unpacked application used by the packaged smoke test.

What the package contains and why it is self-contained:

- The build produces a fully self-contained `dist/` (bundled `main.cjs` with the
  `better-sqlite3` JS wrapper inlined, the sandboxed `preload.cjs`, the renderer
  assets, a copy of the authoritative SQL migrations, and the verified
  Electron-ABI `better_sqlite3.node`). electron-builder packs `dist/` and
  `package.json` into `app.asar`; **no `node_modules` is shipped**, which
  sidesteps `node_modules` collection from bun's symlinked monorepo store.
- The only native artifact, `dist/native/better_sqlite3.node`, is **unpacked**
  from the asar (`asarUnpack: **/*.node`) so Electron can load it; everything
  else stays packed and read-only.
- A `--package` build compiles the synthetic development seed **out** of
  `main.cjs` entirely (esbuild dead-code elimination behind the
  `__JOB_AGENT_PACKAGE_BUILD__` define), so no development fixture ships in the
  production main process — in addition to the runtime `app.isPackaged` guard.
- The package excludes SQLite databases, WAL/SHM files, logs, browser profiles,
  test files, source maps, TypeScript source, and personal data. This is
  enforced by [tests/packaged-smoke.test.ts](tests/packaged-smoke.test.ts),
  which inspects the built `app.asar`.

## Installing and running the installer

Double-click `US Job Agent Setup <version>.exe`. It is an assisted (not one-click)
NSIS installer: it lets you choose a per-user install location and installs
without administrator rights. Launch "US Job Agent" from the Start menu or the
created shortcut.

### Unsigned installer

The Phase 1 installer is **unsigned** — no Authenticode code-signing certificate
is configured, and no signing credentials or code-signing secrets are present in
this repository or its CI. Windows SmartScreen will therefore show an
"unrecognized app" warning on first run (choose "More info" → "Run anyway").
Signing is deliberately out of scope for Phase 1; wiring a certificate in later
means setting electron-builder's `win.signtoolOptions`/`CSC_LINK` from a secret
in the packaging job — it is not a code change here.

### Runtime data location

All mutable runtime data lives beneath Electron's per-user `userData` directory,
`%APPDATA%\US Job Agent\data\` (e.g.
`C:\Users\<you>\AppData\Roaming\US Job Agent\data\job-agent.sqlite3`), never
inside the installed program files or this repository. The path resolver refuses
to place runtime data inside the application/source tree and fails closed if a
path cannot be canonicalized (see
[src/main/runtime-paths.ts](src/main/runtime-paths.ts)). The Settings screen
shows the resolved path.

### Uninstall behavior

Uninstall from "Apps & features" (or the bundled uninstaller). It removes the
installed program files. Per-user runtime data under `%APPDATA%\US Job Agent`
is **left in place** by design (`nsis.deleteAppDataOnUninstall: false`) so a
reinstall keeps your local jobs and applications; delete that folder manually
for a clean wipe.

## Native-artifact verification path

`better-sqlite3` ships a native addon that must match Electron's ABI, not the
host Node ABI the test suite uses. `build.mjs` fetches the Electron-ABI prebuild
with `prebuild-install` and stages it into `dist/native/better_sqlite3.node`.
Because that download happens outside bun's lockfile, the lockfile cannot vouch
for it — a **SHA-256 pin** in `build.mjs` (`nativeArtifactChecksums`) does. The
build refuses to bundle an artifact whose hash does not match.

Electron is pinned to the **41.x** line because its ABI (v145) is the newest
covered by published better-sqlite3 12.x prebuilds. The `electron` devDependency
in `package.json` and `electronVersion` in `electron-builder.yml` must stay in
lockstep.

**Upgrading Electron or better-sqlite3 safely** — do all of this in one reviewed
diff:

1. Bump `electron` in `package.json` (and `electronVersion` in
   `electron-builder.yml`) and/or `better-sqlite3` in `package.json` /
   `packages/database/package.json`, then `bun install` to update `bun.lock`.
2. Confirm the new Electron ABI is covered by a published better-sqlite3
   prebuild. If not, the build fails fast with "No pinned checksum for native
   artifact …".
3. Re-stage the native artifact once, **audit it**, compute its SHA-256, and add
   the new `"better-sqlite3@<v> electron@<v> win32-x64"` entry to
   `nativeArtifactChecksums` in `build.mjs` (replacing the old one).
4. Run the packaged smoke test — `bun run --filter @us-job-agent/desktop package`
   then `node --import tsx --test apps/desktop/tests/packaged-smoke.test.ts` —
   which loads the real unpacked native binding through the packaged layout and
   proves the SQLite round trip still works on the new ABI.

A version bump that skips step 3 cannot ship: the checksum table is the single
gate the build enforces before executing a fetched native binary.

## Privacy and log redaction

- The repository privacy scan (`python tools/privacy_scan.py`, tested by
  `tests/test_privacy_scan.py`) fails if a real-looking email, phone number, or
  credential/token appears in the desktop product source, tests, migrations,
  synthetic fixtures, or the packaged `dist/`. Approved synthetic values pass
  through narrow allowlists (reserved `example.*`/`*.invalid` domains, fictional
  `555-01xx` numbers, labeled redaction placeholders). It never reads the
  personalized job-application workspace (CLAUDE.md, `cv/`, `cover_letters/`,
  `documents/`, the tracker), which holds the real candidate profile.
- The main process logs through one structured, redacting logger
  ([src/shared/log-redaction.ts](src/shared/log-redaction.ts), tested by
  [tests/log-redaction.test.ts](tests/log-redaction.test.ts)): every value is
  scrubbed of contact details, tokens, application answers, and message bodies —
  by field classification and by embedded-value masking — before it reaches a
  log sink. Phase 1 adds no telemetry and makes no network requests.

## Development and test notes

- The test suite includes a real Electron startup smoke test
  ([tests/electron-smoke.test.ts](tests/electron-smoke.test.ts)). It passes
  only when the renderer demonstrably received a validated settings response
  through the real preload/IPC bridge (main reads the rendered DOM back before
  printing the success marker). It skips (rather than fails) where the
  Electron binary has not been fetched; CI runs it for real in the
  `desktop-smoke` Windows job.
- The packaged smoke test
  ([tests/packaged-smoke.test.ts](tests/packaged-smoke.test.ts)) drives the
  **installed layout**: it launches the packaged executable from
  `release/win-unpacked/` with a throwaway `userData` directory and asserts the
  same preload → IPC → SQLite → renderer round trip, that migrations and the
  unpacked native binding load from the packaged asar, that the database is
  created only beneath the temporary runtime directory, and that the package
  contains no database/WAL/log/test/source-map/dev-seed artifact. It also proves
  the smoke hook is harmless — a hostile environment cannot redirect its write
  to an outside path, and it never overwrites an existing file. It skips unless a
  package has been built (`bun run … package`) on Windows; CI runs it for real in
  the `desktop-package` job.
- Because a packaged Windows app is a GUI-subsystem executable whose stdout is
  detached, the packaged smoke run records its success marker in a **fixed**
  file, `smoke-marker.txt`, beneath the app's canonical runtime data directory
  (never a caller-supplied path) using exclusive creation. The stdout marker is
  compiled out of packaging builds so a shipped build never prints runtime paths;
  the unpackaged Electron smoke test reads it from stdout instead.
- In development (`start`, and the Electron smoke test running unpackaged) the
  main process seeds the idempotent synthetic workspace on startup: four jobs
  covering every eligibility outcome (eligible with soft gaps, blocked,
  needs-review, unassessed), three applications progressed through validated
  transitions, and one open review item. A packaged build never seeds — the
  seed is both dead-code-eliminated from the production bundle and guarded by
  `app.isPackaged`. Phase 1 never makes live network requests.
