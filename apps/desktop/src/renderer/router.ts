/**
 * Minimal hash router. The renderer is served from a file:// URL under a
 * strict CSP, so hash fragments are the only navigation primitive that works
 * without touching the network or history APIs on another origin.
 */
import { useSyncExternalStore } from "react";

export type Route =
  | { page: "dashboard" }
  | { page: "jobs"; jobId: string | null }
  | { page: "applications"; applicationId: string | null }
  | { page: "reviews" }
  | { page: "settings" }
  | { page: "not_found"; path: string };

export const hrefs = {
  dashboard: "#/dashboard",
  jobs: "#/jobs",
  job: (jobId: string) => `#/jobs/${encodeURIComponent(jobId)}`,
  applications: "#/applications",
  application: (applicationId: string) =>
    `#/applications/${encodeURIComponent(applicationId)}`,
  reviews: "#/reviews",
  settings: "#/settings",
} as const;

/** Decodes a path segment; malformed percent-encoding yields null instead of throwing. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const [head, second] = segments;
  if (segments.length === 0 || (segments.length === 1 && head === "dashboard")) {
    return { page: "dashboard" };
  }
  if (head === "jobs" && segments.length <= 2) {
    const jobId = second === undefined ? null : decodeSegment(second);
    if (second !== undefined && jobId === null) return { page: "not_found", path };
    return { page: "jobs", jobId };
  }
  if (head === "applications" && segments.length <= 2) {
    const applicationId = second === undefined ? null : decodeSegment(second);
    if (second !== undefined && applicationId === null) {
      return { page: "not_found", path };
    }
    return { page: "applications", applicationId };
  }
  if (head === "reviews" && segments.length === 1) return { page: "reviews" };
  if (head === "settings" && segments.length === 1) return { page: "settings" };
  return { page: "not_found", path };
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", notify);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function currentHash(): string {
  return window.location.hash;
}

/**
 * Navigates by setting the location hash. The native hashchange event fires
 * asynchronously, so subscribers are also notified synchronously; the store
 * snapshot deduplicates the double signal.
 */
export function navigate(href: string): void {
  const target = href.startsWith("#") ? href : `#${href}`;
  if (window.location.hash !== target) {
    window.location.hash = target;
    notify();
  }
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, currentHash);
  return parseRoute(hash);
}
