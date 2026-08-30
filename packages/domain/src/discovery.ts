/**
 * Discovery contracts and the deterministic, dependency-free functions that turn
 * untrusted source output into normalized, deduplicable postings.
 *
 * Everything here is pure and offline: no network, no filesystem, no clock, no
 * model. A `RawPosting` is treated as hostile text — fields are capped and
 * scrubbed, never parsed as code, never trusted for identity beyond exact source
 * id / canonical URL. Cross-source similarity is only ever a *candidate* signal.
 */
import { createHash } from "node:crypto";

export type WorkplaceType = "remote" | "hybrid" | "onsite" | "unknown";

export const sourceCapabilityKeys = [
  "discovery",
  "detailRetrieval",
  "assistedSubmission",
  "autonomousSubmission",
  "outcomeSync",
] as const;

export type SourceCapabilityKey = (typeof sourceCapabilityKeys)[number];

/** What a source is permitted to do. Mirrors the persisted source policy. */
export type SourceCapabilities = Readonly<Record<SourceCapabilityKey, boolean>>;

/**
 * The untrusted shape a source yields. Every field is external input: strings may
 * be arbitrarily long, contain control characters, or be missing entirely.
 */
export type RawPosting = {
  sourceJobId?: string | null;
  url?: string | null;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  workplaceType?: string | null;
  employmentType?: string | null;
  descriptionText?: string | null;
  postedAt?: string | null;
  closesAt?: string | null;
};

/** The deterministic projection of a `RawPosting`, safe to persist. */
export type NormalizedPosting = {
  sourceJobId: string | null;
  canonicalUrl: string | null;
  title: string;
  company: string;
  locationText: string | null;
  workplaceType: WorkplaceType;
  employmentType: string | null;
  descriptionText: string;
  postedAt: string | null;
  closesAt: string | null;
  /** Identifies posting *content*: identical content ⇒ identical hash. */
  contentHash: string;
  /** Conservative cross-source identity signal (company/title/location). */
  fingerprint: string;
};

export const discoveryFailureCategories = [
  "network",
  "timeout",
  "rate_limited",
  "auth",
  "parse",
  "schema",
  "policy",
  // A posting whose canonical URL is already owned by another source. We do not
  // merge across sources, so the posting is dropped — a safe, non-fatal failure
  // that keeps the run non-authoritative rather than silently "succeeding".
  "cross_source_duplicate",
  "internal",
] as const;

export type DiscoveryFailureCategory = (typeof discoveryFailureCategories)[number];

/**
 * A failure reduced to a safe category and a fixed message. Constructed only from
 * the category, so no response body, header, or exception text can ride along
 * into a log or the database.
 */
export type ClassifiedFailure = {
  category: DiscoveryFailureCategory;
  message: string;
};

/** Raw output an adapter returns for one run. Still untrusted. */
export type RawDiscoveryOutput = {
  /**
   * True when the run is a complete crawl whose absence-of-a-posting can be
   * trusted for expiration. A partial page fetch must report false.
   */
  authoritative: boolean;
  postings: readonly RawPosting[];
  failures?: readonly ClassifiedFailure[];
};

export type DiscoveryRunRequest = {
  runId: string;
  sourceKey: string;
  authoritative: boolean;
  now: string;
};

/**
 * A source adapter. `discover` is the single entry point; it may be async. In
 * Phase 2A only fake adapters exist — no adapter performs a network request.
 */
export type SourceAdapter = {
  readonly key: string;
  readonly displayName: string;
  readonly capabilities: SourceCapabilities;
  discover(
    request: DiscoveryRunRequest,
  ): RawDiscoveryOutput | Promise<RawDiscoveryOutput>;
};

/** The engine's per-posting outcome, after normalization. */
export type NormalizedPostingResult =
  | { ok: true; posting: NormalizedPosting }
  | { ok: false; failure: ClassifiedFailure };

/** The engine's outcome for a whole run. */
export type DiscoveryResult = {
  runId: string;
  status: "succeeded" | "partial" | "failed" | "skipped";
  authoritative: boolean;
  postings: readonly NormalizedPosting[];
  failures: readonly ClassifiedFailure[];
};

/**
 * A failure that carries only a classification, never external content. Adapters
 * throw this so the engine can record a category without a message that might
 * echo a hostile response.
 */
export class DiscoveryFailureError extends Error {
  readonly category: DiscoveryFailureCategory;
  constructor(category: DiscoveryFailureCategory) {
    super(safeFailureMessage(category));
    this.name = "DiscoveryFailureError";
    this.category = category;
  }
}

const failureMessages: Readonly<Record<DiscoveryFailureCategory, string>> = {
  network: "The source could not be reached.",
  timeout: "The source did not respond in time.",
  rate_limited: "The source rate-limited the request.",
  auth: "The source rejected the credentials.",
  parse: "The source response could not be parsed.",
  schema: "A posting did not match the expected shape.",
  policy: "The source is not permitted to run.",
  cross_source_duplicate: "The posting's URL is already owned by another source.",
  internal: "A discovery step failed.",
};

export function safeFailureMessage(
  category: DiscoveryFailureCategory,
): string {
  return failureMessages[category];
}

function isFailureCategory(value: unknown): value is DiscoveryFailureCategory {
  return (
    typeof value === "string" &&
    (discoveryFailureCategories as readonly string[]).includes(value)
  );
}

/**
 * Reduce any thrown value to a safe classified failure. Only the category is ever
 * read off the error; the message is fixed, so untrusted text cannot leak.
 */
export function classifyFailure(error: unknown): ClassifiedFailure {
  if (error instanceof DiscoveryFailureError) {
    return { category: error.category, message: safeFailureMessage(error.category) };
  }
  return { category: "internal", message: safeFailureMessage("internal") };
}

/**
 * Coerce any value an adapter presents as a "classified failure" into a real one.
 * Accepts `unknown`: null, strings, empty objects, and unknown categories all
 * reduce to a fixed `internal` failure. The message is always regenerated from
 * the category, so an adapter can never smuggle text through this boundary, and
 * a malformed entry can never throw during finalization.
 */
export function sanitizeClassifiedFailure(value: unknown): ClassifiedFailure {
  const category: DiscoveryFailureCategory =
    value !== null &&
    typeof value === "object" &&
    "category" in value &&
    isFailureCategory((value as { category: unknown }).category)
      ? ((value as { category: DiscoveryFailureCategory }).category)
      : "internal";
  return { category, message: safeFailureMessage(category) };
}

const fieldCaps = {
  title: 500,
  company: 300,
  location: 500,
  employmentType: 100,
  description: 200_000,
  timestamp: 64,
  url: 2_000,
} as const;

const controlCharacters = /[\u0000-\u001f\u007f]+/g;

/** Strip control characters and collapse runs of whitespace. */
function scrub(value: string): string {
  return value.replace(controlCharacters, " ").replace(/\s+/g, " ").trim();
}

function scrubbed(value: string | null | undefined, cap: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = scrub(value);
  if (cleaned === "") return null;
  return cleaned.length > cap ? cleaned.slice(0, cap) : cleaned;
}

const trackingParameters = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gh_src",
  "gh_jid",
  "ref",
  "source",
  "src",
]);

/**
 * Deterministically canonicalize a URL for identity comparison. Returns null when
 * the input is not a parseable absolute http(s) URL. Lowercases scheme/host,
 * drops the default port, drops the fragment, removes known tracking parameters,
 * sorts the remainder, and trims a trailing slash.
 */
export function canonicalizeUrl(raw: string | null | undefined): string | null {
  const candidate = scrubbed(raw, fieldCaps.url);
  if (candidate === null) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  const kept: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams) {
    if (!trackingParameters.has(key.toLowerCase())) kept.push([key, value]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);

  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

const workplaceAliases: Readonly<Record<string, WorkplaceType>> = {
  remote: "remote",
  "fully remote": "remote",
  hybrid: "hybrid",
  onsite: "onsite",
  "on-site": "onsite",
  "on site": "onsite",
  "in office": "onsite",
  "in-office": "onsite",
};

function normalizeWorkplace(value: string | null): WorkplaceType {
  if (value === null) return "unknown";
  return workplaceAliases[value.toLowerCase()] ?? "unknown";
}

const combiningMarks = /[\u0300-\u036f]/g;
const nonIdentityCharacters = /[^a-z0-9]+/g;

function foldForIdentity(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(combiningMarks, "")
    .replace(nonIdentityCharacters, " ")
    .trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Content hash over the normalized content fields, in a fixed order. */
export function computeContentHash(
  fields: Pick<
    NormalizedPosting,
    | "title"
    | "company"
    | "locationText"
    | "workplaceType"
    | "employmentType"
    | "descriptionText"
    | "postedAt"
    | "closesAt"
  >,
): string {
  return sha256(
    [
      fields.title,
      fields.company,
      fields.locationText ?? "",
      fields.workplaceType,
      fields.employmentType ?? "",
      fields.descriptionText,
      fields.postedAt ?? "",
      fields.closesAt ?? "",
    ].join("\u0000"),
  );
}

/**
 * Conservative cross-source fingerprint. Folds company, title, and location to an
 * identity-insensitive form. Two postings sharing a fingerprint are *candidates*
 * for being the same role — never automatically merged.
 */
export function computeFingerprint(
  fields: Pick<NormalizedPosting, "company" | "title" | "locationText">,
): string {
  return sha256(
    [
      foldForIdentity(fields.company),
      foldForIdentity(fields.title),
      foldForIdentity(fields.locationText ?? ""),
    ].join("\u0000"),
  );
}

/**
 * Normalize one untrusted `RawPosting`. Succeeds only when the posting carries
 * the minimum trustworthy content (title, company, description) and an identity
 * (a source job id or a canonical URL); otherwise returns a `schema` failure.
 */
export function normalizePosting(raw: RawPosting): NormalizedPostingResult {
  const title = scrubbed(raw.title, fieldCaps.title);
  const company = scrubbed(raw.company, fieldCaps.company);
  const descriptionText = scrubbed(raw.descriptionText, fieldCaps.description);
  const sourceJobId = scrubbed(raw.sourceJobId, fieldCaps.title);
  const canonicalUrl = canonicalizeUrl(raw.url);

  if (title === null || company === null || descriptionText === null) {
    return { ok: false, failure: { category: "schema", message: safeFailureMessage("schema") } };
  }
  if (sourceJobId === null && canonicalUrl === null) {
    return { ok: false, failure: { category: "schema", message: safeFailureMessage("schema") } };
  }

  const locationText = scrubbed(raw.location, fieldCaps.location);
  const workplaceType = normalizeWorkplace(scrubbed(raw.workplaceType, 40));
  const employmentType = scrubbed(raw.employmentType, fieldCaps.employmentType);
  const postedAt = scrubbed(raw.postedAt, fieldCaps.timestamp);
  const closesAt = scrubbed(raw.closesAt, fieldCaps.timestamp);

  const content = {
    title,
    company,
    locationText,
    workplaceType,
    employmentType,
    descriptionText,
    postedAt,
    closesAt,
  };

  return {
    ok: true,
    posting: {
      sourceJobId,
      canonicalUrl,
      ...content,
      contentHash: computeContentHash(content),
      fingerprint: computeFingerprint(content),
    },
  };
}

export type DiscoveryGateInput = {
  /** Whether the source has been registered with a policy at all. */
  sourceRegistered: boolean;
  discoveryAllowed: boolean;
  sourceEnabled: boolean;
  killSwitchEngaged: boolean;
  globallyPaused: boolean;
};

export type DiscoveryGateDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * The single policy decision on whether a source may run. Pure so it can be
 * tested and reused by the orchestrator, which must *not* call the adapter when
 * this denies. Fails closed: any unmet precondition denies.
 */
export function evaluateDiscoveryGate(
  input: DiscoveryGateInput,
): DiscoveryGateDecision {
  if (!input.sourceRegistered) {
    return { allowed: false, reason: "The source has no registered policy." };
  }
  if (!input.discoveryAllowed) {
    return { allowed: false, reason: "The source policy does not permit discovery." };
  }
  if (input.killSwitchEngaged) {
    return { allowed: false, reason: "The source kill switch is engaged." };
  }
  if (!input.sourceEnabled) {
    return { allowed: false, reason: "The source is disabled." };
  }
  if (input.globallyPaused) {
    return { allowed: false, reason: "Global automation is paused." };
  }
  return { allowed: true };
}
