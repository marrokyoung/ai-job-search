import { describe, expect, test } from "bun:test";
import {
  canonicalizeUrl,
  classifyFailure,
  computeContentHash,
  computeFingerprint,
  DiscoveryFailureError,
  evaluateDiscoveryGate,
  normalizePosting,
  safeFailureMessage,
  sanitizeClassifiedFailure,
  type RawPosting,
} from "../src/discovery.ts";

const baseRaw: RawPosting = {
  sourceJobId: "req-1",
  url: "https://boards.example.com/acme/jobs/1",
  title: "Staff Engineer",
  company: "Acme Corp",
  location: "Detroit, MI",
  workplaceType: "Hybrid",
  employmentType: "Full-time",
  descriptionText: "Build resilient systems.",
};

describe("normalizePosting", () => {
  test("is deterministic and produces stable hashes", () => {
    const a = normalizePosting(baseRaw);
    const b = normalizePosting(baseRaw);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.posting.contentHash).toBe(b.posting.contentHash);
      expect(a.posting.fingerprint).toBe(b.posting.fingerprint);
      expect(a.posting.workplaceType).toBe("hybrid");
    }
  });

  test("changed content changes the content hash but not the fingerprint", () => {
    const first = normalizePosting(baseRaw);
    const changed = normalizePosting({ ...baseRaw, descriptionText: "New scope of work." });
    expect(first.ok && changed.ok).toBe(true);
    if (first.ok && changed.ok) {
      expect(changed.posting.contentHash).not.toBe(first.posting.contentHash);
      // Company/title/location are unchanged, so identity is unchanged.
      expect(changed.posting.fingerprint).toBe(first.posting.fingerprint);
    }
  });

  test("rejects postings missing required content", () => {
    const { descriptionText: _omit, ...withoutDescription } = baseRaw;
    expect(normalizePosting({ ...baseRaw, title: "   " }).ok).toBe(false);
    expect(normalizePosting({ ...baseRaw, company: null }).ok).toBe(false);
    expect(normalizePosting(withoutDescription).ok).toBe(false);
  });

  test("rejects a posting with no identity", () => {
    const result = normalizePosting({ ...baseRaw, sourceJobId: null, url: "not-a-url" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.category).toBe("schema");
  });

  test("scrubs control characters and caps field length", () => {
    const noisy = normalizePosting({
      ...baseRaw,
      title: "Staff\u0000\u0007 Engineer\t\tII",
      descriptionText: "x".repeat(300_000),
    });
    expect(noisy.ok).toBe(true);
    if (noisy.ok) {
      expect(noisy.posting.title).toBe("Staff Engineer II");
      expect(noisy.posting.descriptionText.length).toBe(200_000);
    }
  });
});

describe("canonicalizeUrl", () => {
  test("normalizes case, port, fragment, tracking params, and trailing slash", () => {
    expect(
      canonicalizeUrl("HTTPS://Boards.Example.com:443/acme/jobs/1/?utm_source=x&b=2&a=1#apply"),
    ).toBe("https://boards.example.com/acme/jobs/1?a=1&b=2");
  });

  test("returns null for non-http(s) or unparseable input", () => {
    expect(canonicalizeUrl("ftp://example.com/a")).toBeNull();
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalizeUrl("   ")).toBeNull();
  });

  test("two postings with only tracking-param differences share identity", () => {
    expect(canonicalizeUrl("https://x.example.com/j/9?gh_src=abc")).toBe(
      canonicalizeUrl("https://x.example.com/j/9?gh_src=zzz"),
    );
  });
});

describe("fingerprint and content hash", () => {
  test("fingerprint folds case, whitespace, and punctuation for identity", () => {
    const one = computeFingerprint({ company: "Acme, Corp.", title: "Staff  Engineer", locationText: "Detroit" });
    const two = computeFingerprint({ company: "ACME CORP", title: "staff engineer", locationText: "detroit" });
    expect(one).toBe(two);
  });

  test("content hash reacts to any content field", () => {
    const base = {
      title: "t",
      company: "c",
      locationText: null,
      workplaceType: "remote" as const,
      employmentType: null,
      descriptionText: "d",
      postedAt: null,
      closesAt: null,
    };
    expect(computeContentHash(base)).not.toBe(
      computeContentHash({ ...base, closesAt: "2026-01-01" }),
    );
  });
});

describe("classifyFailure", () => {
  test("keeps only the category and a fixed safe message", () => {
    const classified = classifyFailure(new DiscoveryFailureError("rate_limited"));
    expect(classified).toEqual({
      category: "rate_limited",
      message: safeFailureMessage("rate_limited"),
    });
  });

  test("reduces an arbitrary error to internal without leaking its message", () => {
    const hostileMessage = "SENSITIVE-RESPONSE-BODY-marker-abc123";
    const classified = classifyFailure(new Error(hostileMessage));
    expect(classified.category).toBe("internal");
    expect(classified.message).not.toContain("SENSITIVE");
    expect(classified.message).not.toContain("abc123");
  });
});

describe("sanitizeClassifiedFailure", () => {
  test("keeps a valid category but always regenerates the message", () => {
    const result = sanitizeClassifiedFailure({
      category: "rate_limited",
      message: "SECRET-body-leak-token",
    });
    expect(result).toEqual({
      category: "rate_limited",
      message: safeFailureMessage("rate_limited"),
    });
  });

  test("reduces every malformed value to a fixed internal failure", () => {
    for (const bad of [
      null,
      undefined,
      "a string",
      42,
      {},
      { category: null },
      { category: 7 },
      { category: "totally-made-up" },
      [],
    ]) {
      const result = sanitizeClassifiedFailure(bad);
      expect(result).toEqual({
        category: "internal",
        message: safeFailureMessage("internal"),
      });
    }
  });
});

describe("evaluateDiscoveryGate", () => {
  const allowed = {
    sourceRegistered: true,
    discoveryAllowed: true,
    sourceEnabled: true,
    killSwitchEngaged: false,
    globallyPaused: false,
  };

  test("allows only when every precondition is met", () => {
    expect(evaluateDiscoveryGate(allowed).allowed).toBe(true);
  });

  test("fails closed on each denial condition", () => {
    expect(evaluateDiscoveryGate({ ...allowed, sourceRegistered: false }).allowed).toBe(false);
    expect(evaluateDiscoveryGate({ ...allowed, discoveryAllowed: false }).allowed).toBe(false);
    expect(evaluateDiscoveryGate({ ...allowed, sourceEnabled: false }).allowed).toBe(false);
    expect(evaluateDiscoveryGate({ ...allowed, killSwitchEngaged: true }).allowed).toBe(false);
    expect(evaluateDiscoveryGate({ ...allowed, globallyPaused: true }).allowed).toBe(false);
  });
});
