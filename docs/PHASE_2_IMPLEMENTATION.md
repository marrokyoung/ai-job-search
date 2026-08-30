# Phase 2 Implementation Plan: US Discovery

## Objective

Turn the Phase 1 shell into a system that continuously **discovers** US jobs
from permitted, documented sources; normalizes and deduplicates them
deterministically; tracks their freshness and expiration; reports source health;
and does all of this without ever redesigning the Phase 1 renderer, calling an AI
model, or making a production network request until an adapter is deliberately
switched on.

Phase 2 is deliberately split so each slice ships behind tests and a kill switch
before the next one adds risk. **This document describes all of Phase 2; only
Phase 2A is implemented in this task.**

## Non-goals for all of Phase 2

- No submission, form filling, browser automation, or Easy Apply.
- No LinkedIn scraping, inbox scraping, or email access.
- No candidate-evidence import or document tailoring (Phase 3+).
- No arbitrary user-supplied URL fetching or general web crawling.
- No AI/model calls anywhere in the discovery path — normalization,
  deduplication, and expiration are deterministic domain logic.

## Phase 2A — Discovery foundation (this task)

The contracts, persistence, and deterministic ingestion engine that every later
source adapter plugs into. No real source runs; a fake adapter, a fake clock, and
synthetic fixtures exercise the whole pipeline offline.

**Discovery contracts (`@us-job-agent/domain`)**

- `SourceCapabilities` / `SourceAdapter` — a source declares what it may do and
  exposes a single `discover()` entry point that returns raw, untrusted output.
- `RawPosting` — the untrusted shape a source yields; nothing is trusted, nothing
  is executed, every field is treated as hostile text.
- `NormalizedPosting` — the deterministic projection of a `RawPosting`: canonical
  URL, capped/scrubbed fields, a content hash, and a conservative cross-source
  fingerprint.
- `DiscoveryResult` — the outcome of one run: normalized postings, classified
  failures, and whether the run was authoritative.
- `ClassifiedFailure` — a failure reduced to a safe category and a fixed message
  so response bodies never reach a log or the database.
- Pure functions: `normalizePosting`, `canonicalizeUrl`, `computeContentHash`,
  `computeFingerprint`, `classifyFailure`, and `evaluateDiscoveryGate` (the policy
  decision on whether a source may run at all).

**Persistence (`0002_discovery.sql`, additive migration)**

- `discovery_runs` — one row per run: source, trigger, authoritative flag,
  status, timings, and counts.
- `discovery_run_failures` — append-only, per-run classified failures (safe text
  only).
- `source_discovery_settings` — per-source enable/disable, kill switch, and the
  documented expiration grace period.
- `source_health` — the rebuildable last-run projection per source.
- `posting_observations` — append-only "seen in this run" records; the authority
  for last-seen and expiration.
- `job_discovery_state` — per-job freshness/expiration projection plus its
  canonical fingerprint.
- `job_duplicate_links` — inspectable cross-source fingerprint candidates;
  ambiguous matches are recorded, never merged.
- Immutability triggers make `job_snapshots`, `posting_observations`, and
  `discovery_run_failures` append-only; `discovery_runs` cannot be deleted.
- Operational changes (source registration, enable/disable, kill switch, run
  lifecycle) are written to the existing append-only `audit_events`.

**Ingestion engine (`@us-job-agent/database`)**

- `DiscoveryRepository` — `registerSource`, `setSourceEnabled`, `engageKillSwitch`,
  atomic `ingestPosting`, `startRun`/`finishRun`, and read-model queries
  (`listRuns`, `getSourceHealth`, `listDuplicateLinks`).
- `runDiscovery(database, adapter, options)` — the orchestrator: it evaluates the
  gate, and **only if allowed** calls the adapter, normalizes each posting,
  ingests atomically, classifies failures, and finishes the run. Expiration runs
  only after a successful authoritative run, under the grace policy.

The Phase 1 renderer and IPC surface are untouched. Read-model queries exist for
2D to consume later; no new IPC channel is added in 2A.

## Phase 2B — Greenhouse and Lever adapters

- Implement real `SourceAdapter`s for public Greenhouse and Lever job boards
  against their documented public JSON, behind the capability/policy gate.
- Add per-source fixtures captured from public boards (synthetic/redacted) and a
  contract test that every adapter's output survives `normalizePosting`.
- Introduce a minimal, audited HTTP client restricted to the source's documented
  host; still no browser automation. This is the first slice that makes real
  network requests, and only for explicitly enabled sources.
- `robots`/terms review, rate-limit ceilings, and a kill switch precede enabling
  either source by default (they ship disabled).

## Phase 2C — Scheduling and source health

- A main-process scheduler that runs enabled sources on a cadence, honoring
  global pause, per-source enable, kill switch, and daily ceilings.
- Retry/backoff state and rate-limit accounting per source.
- Health reporting: consecutive failures, last success, next scheduled run, and
  automatic disable after repeated authoritative failures.

## Phase 2D — Discovery UI

- Additive IPC read channels for the jobs feed (freshness, source, expiration),
  source health, and recent runs.
- Dashboard "worker health / next search" surfaces and a Sources settings screen
  with per-source enable and kill-switch controls.
- Duplicate-link inspection surfaced in the Jobs view.

## Phase 2E — Hardening and CI

- Fuzz/property tests for normalization and canonicalization on hostile input.
- Migration-forward tests from every prior shipped schema version.
- CI jobs for the discovery engine, privacy scan over new fixtures, and a
  packaged smoke test that the discovery schema loads in the installed layout.
- Documented runbook for enabling a source, reading health, and pulling a kill
  switch.

## Cross-cutting invariants (hold from 2A onward)

- SQLite is authoritative; versioned SQL is the only schema authority; migrations
  are additive and never edited after shipping.
- Re-seeing a posting updates last-seen without duplicating the job; identical
  content adds no snapshot; changed content adds exactly one immutable snapshot.
- Exact source identity and same-source canonical-URL matches deduplicate
  deterministically. A canonical URL already owned by a *different* source is not
  merged (that would corrupt source ownership and expiration); the collision is
  recorded in the audit log, classified as a safe `cross_source_duplicate`
  failure (so the run is partial, never a clean authoritative success that could
  expire jobs), and the posting is dropped. Cross-source fingerprint matches are
  conservative, inspectable, and never auto-merge; ambiguous matches stay
  separate. A per-job multi-source identity relation is deferred to 2B.
- A partial or failed run never expires unseen jobs; expiration happens only
  after a successful authoritative run and a documented grace period.
- Adapter output is untrusted and fails closed: a missing/non-array `postings`
  (or `failures`) is a fault — it records a safe failure and drops effective
  authority to false, so a malformed response can never masquerade as an empty
  authoritative crawl and expire jobs.
- Every posting's ingestion writes are atomic.
- A source cannot run until its capabilities and policy are defined; per-source
  enable/disable and a global kill switch gate execution; the renderer never
  touches network, filesystem, or database directly.
- Failure details and logs carry classified categories and safe messages only —
  never raw response content.
</content>
