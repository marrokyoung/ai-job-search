import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type RuntimePaths = {
  /** Directory that holds all mutable runtime data (databases, logs). */
  dataDirectory: string;
  /** Absolute path of the SQLite database file. */
  databaseFile: string;
};

function isPathInside(child: string, parent: string): boolean {
  const relativePath = relative(parent, child);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

/**
 * Resolves junctions/symlinks so the containment check cannot be bypassed by
 * linking into the protected tree. Non-existent trailing segments are kept
 * verbatim on top of the deepest existing ancestor's real path — safe because
 * a segment that does not exist cannot be a junction. This is a privacy
 * boundary, so it fails closed: a path whose existing ancestor cannot be
 * canonicalized is rejected rather than checked lexically.
 */
function canonicalize(path: string): string {
  let existing = resolve(path);
  let remainder = "";
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    remainder = remainder === "" ? basename(existing) : join(basename(existing), remainder);
    existing = parent;
  }
  try {
    existing = realpathSync.native(existing);
  } catch (error) {
    throw new Error(
      `Cannot canonicalize runtime path "${path}"; refusing to use it for runtime data. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return remainder === "" ? existing : join(existing, remainder);
}

/**
 * In development `app.getAppPath()` is `<repo>/apps/desktop`, but the whole
 * repository checkout must be protected from runtime data — not just the
 * desktop package. Walk upward and protect the outermost enclosing directory
 * that looks like a repository root (contains `.git`). A packaged app has no
 * such marker and protects its own application directory.
 */
function findProtectedRoot(applicationSourceDirectory: string): string {
  const start = canonicalize(applicationSourceDirectory);
  let protectedRoot = start;
  let current = start;
  while (true) {
    if (existsSync(join(current, ".git"))) protectedRoot = current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return protectedRoot;
}

/**
 * Resolves where runtime data lives. All runtime data goes beneath Electron's
 * per-user `userData` directory and is refused if that would place it inside
 * the protected source tree (the enclosing repository checkout during
 * development, the packaged app directory in production), so private state
 * can never end up in source control or a distributable. Both sides of the
 * check are canonicalized first.
 */
export function resolveRuntimePaths(input: {
  userDataDirectory: string;
  applicationSourceDirectory: string;
}): RuntimePaths {
  const userData = input.userDataDirectory.trim();
  if (!userData || !isAbsolute(userData)) {
    throw new Error("The userData directory must be an absolute path.");
  }
  const protectedRoot = findProtectedRoot(input.applicationSourceDirectory);
  const dataDirectory = join(canonicalize(userData), "data");
  if (isPathInside(dataDirectory, protectedRoot)) {
    throw new Error(
      "Runtime data must live outside the application source tree; refusing to store the database in the repository.",
    );
  }
  return {
    dataDirectory,
    databaseFile: join(dataDirectory, "job-agent.sqlite3"),
  };
}
