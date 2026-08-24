// Builds the Electron app into dist/: bundled main (CJS), bundled sandboxed
// preload (CJS), bundled renderer script, static renderer assets, a copy of
// the versioned SQL migrations (the schema authority stays in
// packages/database/migrations; this is a build artifact), and the
// Electron-ABI build of better-sqlite3's native addon.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const distDirectory = join(packageRoot, "dist");
const nodeRequire = createRequire(import.meta.url);

// A production packaging build (run by the `package`/`package:dir` scripts
// before electron-builder, via the JOB_AGENT_PACKAGE_BUILD env var; the
// `--package` flag is also honored for direct `node build.mjs --package` use).
// It compiles the synthetic development seed OUT of the main bundle entirely —
// see the `__JOB_AGENT_PACKAGE_BUILD__` define below — instead of only guarding
// it at runtime, so no development fixture ships inside the production main
// process.
const isPackageBuild =
  process.argv.includes("--package") || process.env.JOB_AGENT_PACKAGE_BUILD === "1";

rmSync(distDirectory, { recursive: true, force: true });

// Main process: Node platform, CJS (Electron's default main entry format).
// import.meta.url is shimmed so path resolution keeps working after bundling.
//
// `electron` stays external (Electron provides it to its own main process).
// `better-sqlite3` is bundled in, not left external: the packaged app ships a
// self-contained dist/ with no node_modules, and this repo's monorepo uses
// bun's symlinked package store, which makes runtime node_modules collection
// fragile. Bundling the pure-JS wrapper keeps the ONLY native artifact the
// verified, checksum-pinned Electron-ABI better_sqlite3.node staged into
// dist/native/ and loaded through the explicit `nativeBinding` path (see
// packages/database/src/bundled.ts). The wrapper's fallback `require('bindings')`
// branch is never reached because that path is always supplied, so no dynamic
// native lookup happens at runtime.
await build({
  entryPoints: [join(packageRoot, "src/main/main.ts")],
  outfile: join(distDirectory, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  // Removes dead branches (`if (false) { … }`) and tree-shakes what they made
  // unreachable — notably the synthetic seed in a packaging build — while
  // keeping identifiers and whitespace so the bundled main stays debuggable.
  minifySyntax: true,
  define: {
    "import.meta.url": "__import_meta_url",
    // Compile-time constant. In a packaging build this is `true`, so the
    // `if (!__JOB_AGENT_PACKAGE_BUILD__ && …)` seed guard in main.ts becomes
    // dead code and esbuild eliminates both the call and the side-effect-free
    // seed module (synthetic companies, jobs, and applications) from the
    // bundle. In a development build it is `false`, so the seed is retained and
    // still gated at runtime by `!app.isPackaged`.
    __JOB_AGENT_PACKAGE_BUILD__: JSON.stringify(isPackageBuild),
  },
  banner: {
    js: "const __import_meta_url = require('node:url').pathToFileURL(__filename).href;",
  },
});

// Preload: runs in Electron's sandboxed preload environment — must be a
// self-contained CJS bundle whose only require is "electron".
await build({
  entryPoints: [join(packageRoot, "src/preload/preload.ts")],
  outfile: join(distDirectory, "preload.cjs"),
  bundle: true,
  platform: "browser",
  format: "cjs",
  external: ["electron"],
});

// Renderer: plain browser bundle (React UI), no Node access.
await build({
  entryPoints: [join(packageRoot, "src/renderer/main.tsx")],
  outfile: join(distDirectory, "renderer", "renderer.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  // React's development build is noisier and slower; the bundle always ships
  // the production build since Phase 1 has no renderer dev-server workflow.
  define: { "process.env.NODE_ENV": '"production"' },
});

cpSync(
  join(packageRoot, "src/renderer/index.html"),
  join(distDirectory, "renderer", "index.html"),
);
cpSync(
  join(packageRoot, "src/renderer/styles.css"),
  join(distDirectory, "renderer", "styles.css"),
);
cpSync(
  join(packageRoot, "../../packages/database/migrations"),
  join(distDirectory, "migrations"),
  { recursive: true },
);

/**
 * SHA-256 of every native artifact this build is allowed to execute, keyed by
 * dependency versions and platform. The download happens outside bun's
 * lockfile, so the lockfile cannot vouch for it — this table does instead.
 * Adding support for a new platform, Electron version, or better-sqlite3
 * version means staging the artifact once, hashing it, auditing it, and
 * appending the pin here in the same reviewable diff (the same pattern
 * tools/security_guards.py uses for permissions). Phase 1E's packaging
 * pipeline is expected to replace this with centrally produced, verified
 * native artifacts.
 */
const nativeArtifactChecksums = {
  "better-sqlite3@12.10.0 electron@41.10.5 win32-x64":
    "fc29e5cb569b3ae3fbdac600ab42a3d4dd6283a057a0709c7448aa98b1d4964d",
};

/**
 * Stages better-sqlite3's native addon built for Electron's ABI into
 * dist/native/. The copy installed by bun targets the host Node ABI (used by
 * the test suite); Electron needs its own build, which better-sqlite3
 * publishes as a prebuilt binary. prebuild-install caches downloads, so this
 * touches the network only the first time for a given version pair. The
 * Electron version pinned in package.json must have an ABI covered by
 * better-sqlite3's published prebuilds, and the fetched artifact must match
 * its pinned checksum above before it is placed in the bundle.
 */
function stageElectronNativeModule() {
  if (process.env.JOB_AGENT_SKIP_ELECTRON_NATIVE === "1") {
    console.warn(
      "Skipping Electron native-module staging (JOB_AGENT_SKIP_ELECTRON_NATIVE=1). " +
        "The built app will NOT start until dist/native/better_sqlite3.node exists.",
    );
    return;
  }
  const betterSqlitePackageJson = nodeRequire.resolve("better-sqlite3/package.json", {
    paths: [packageRoot],
  });
  const prebuildInstall = nodeRequire.resolve("prebuild-install/bin.js", {
    paths: [dirname(betterSqlitePackageJson)],
  });
  const electronPackageJson = nodeRequire.resolve("electron/package.json", {
    paths: [packageRoot],
  });
  const electronVersion = JSON.parse(readFileSync(electronPackageJson, "utf8")).version;
  const betterSqliteVersion = JSON.parse(
    readFileSync(betterSqlitePackageJson, "utf8"),
  ).version;

  const artifactKey = `better-sqlite3@${betterSqliteVersion} electron@${electronVersion} ${process.platform}-${process.arch}`;
  const expectedChecksum = nativeArtifactChecksums[artifactKey];
  if (!expectedChecksum) {
    throw new Error(
      `No pinned checksum for native artifact "${artifactKey}". Stage it once, audit it, ` +
        "hash it with SHA-256, and add the pin to nativeArtifactChecksums in build.mjs " +
        "in the same reviewable diff.",
    );
  }

  const staging = mkdtempSync(join(tmpdir(), "job-agent-native-"));
  try {
    copyFileSync(betterSqlitePackageJson, join(staging, "package.json"));
    const result = spawnSync(
      process.execPath,
      [
        prebuildInstall,
        "--runtime",
        "electron",
        "--target",
        electronVersion,
        "--platform",
        process.platform,
        "--arch",
        process.arch,
      ],
      { cwd: staging, stdio: "inherit" },
    );
    if (result.status !== 0) {
      throw new Error(
        `Fetching the better-sqlite3 prebuild for Electron ${electronVersion} failed. ` +
          "Check network access and that the pinned Electron version's ABI is covered by " +
          "better-sqlite3's published prebuilds. Set JOB_AGENT_SKIP_ELECTRON_NATIVE=1 to " +
          "build without it (the app will not start).",
      );
    }
    const stagedArtifact = join(staging, "build", "Release", "better_sqlite3.node");
    const actualChecksum = createHash("sha256")
      .update(readFileSync(stagedArtifact))
      .digest("hex");
    if (actualChecksum !== expectedChecksum) {
      throw new Error(
        `Native artifact "${artifactKey}" failed checksum verification ` +
          `(expected ${expectedChecksum}, got ${actualChecksum}). Refusing to bundle it. ` +
          "If the upstream release was legitimately republished, re-audit the artifact " +
          "and update the pin in build.mjs.",
      );
    }
    mkdirSync(join(distDirectory, "native"), { recursive: true });
    copyFileSync(stagedArtifact, join(distDirectory, "native", "better_sqlite3.node"));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

stageElectronNativeModule();

console.log(
  `Built apps/desktop/dist${isPackageBuild ? " (packaging build: synthetic seed excluded)" : ""}`,
);
