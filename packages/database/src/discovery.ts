/**
 * Discovery persistence and the deterministic ingestion engine.
 *
 * `DiscoveryRepository` owns the atomic per-posting writes, run lifecycle,
 * source controls, and read-model queries. `runDiscovery` is the orchestrator:
 * it evaluates the policy gate and, only when allowed, calls the adapter,
 * normalizes each untrusted posting, ingests it atomically, records classified
 * failures, and finishes the run — expiring stale jobs only after a successful
 * authoritative run under the source's grace policy.
 *
 * No network, no model, no filesystem. Phase 2A runs fake adapters only.
 */
import { randomUUID } from "node:crypto";
import {
  classifyFailure,
  evaluateDiscoveryGate,
  normalizePosting,
  safeFailureMessage,
  sanitizeClassifiedFailure,
  type ClassifiedFailure,
  type DiscoveryResult,
  type NormalizedPosting,
  type RawDiscoveryOutput,
  type SourceAdapter,
  type SourceCapabilities,
  // Node-only subpath: discovery hashing uses node:crypto, so it must not sit on
  // the domain index the browser renderer bundles. ponytail: subpath, not a JS
  // reimplementation of SHA-256.
} from "@us-job-agent/domain/discovery";
import type Database from "better-sqlite3";
import { getDatabaseConnection } from "./database-internal.ts";
import type { JobAgentDatabase } from "./database.ts";

export type RegisterSourceInput = {
  sourceKey: string;
  displayName: string;
  capabilities: SourceCapabilities;
  enabled?: boolean;
  expirationGraceSeconds?: number;
  now?: string;
};

export type IngestResult = {
  jobId: string;
  snapshotId: string;
  isNewJob: boolean;
  isNewSnapshot: boolean;
};

export type DiscoveryRunOptions = {
  authoritative?: boolean;
  trigger?: "manual" | "scheduled" | "test";
  now?: string;
};

export type DiscoveryRunView = {
  id: string;
  sourceKey: string;
  trigger: string;
  authoritative: boolean;
  status: "running" | "succeeded" | "partial" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string | null;
  postingsSeen: number;
  newJobs: number;
  newSnapshots: number;
  failureCount: number;
  expiredJobs: number;
  skipReason: string | null;
};

export type SourceHealthView = {
  sourceKey: string;
  enabled: boolean;
  killSwitchEngaged: boolean;
  lastStatus: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
};

export type DuplicateLinkView = {
  jobId: string;
  matchedJobId: string;
  fingerprint: string;
  matchType: string;
  status: "candidate" | "ambiguous";
  createdAt: string;
};

function normalizeOrganizationName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function iso(now: string | undefined): string {
  return now ?? new Date().toISOString();
}

export class UnknownSourceError extends Error {
  constructor(sourceKey: string) {
    super(`Source ${sourceKey} is not registered.`);
    this.name = "UnknownSourceError";
  }
}

type SourceRow = {
  id: string;
  discovery_allowed: 0 | 1;
  enabled: 0 | 1;
  kill_switch_engaged: 0 | 1;
  expiration_grace_seconds: number;
};

export class DiscoveryRepository {
  constructor(private readonly database: JobAgentDatabase) {}

  private get sqlite(): Database.Database {
    return getDatabaseConnection(this.database);
  }

  private auditDiscovery(
    sqlite: Database.Database,
    eventName: string,
    now: string,
    details: Record<string, unknown>,
  ): void {
    sqlite
      .prepare(
        `INSERT INTO audit_events (id, event_name, actor, occurred_at, details_json)
         VALUES (?, ?, 'system', ?, ?)`,
      )
      .run(randomUUID(), eventName, now, JSON.stringify(details));
  }

  /**
   * Register (or update) a source's capabilities, policy, operational controls,
   * and health row. A source cannot run until this exists.
   */
  registerSource(input: RegisterSourceInput): string {
    const now = iso(input.now);
    const caps = input.capabilities;
    return this.sqlite.transaction(() => {
      const existing = this.sqlite
        .prepare("SELECT id FROM job_sources WHERE source_key = ?")
        .get(input.sourceKey) as { id: string } | undefined;
      const sourceId = existing?.id ?? randomUUID();
      if (!existing) {
        this.sqlite
          .prepare(
            `INSERT INTO job_sources (id, source_key, display_name, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(sourceId, input.sourceKey, input.displayName, now);
      }
      this.sqlite
        .prepare(
          `INSERT INTO source_policies (
             source_id, discovery_allowed, detail_retrieval_allowed,
             assisted_submission_allowed, autonomous_submission_allowed,
             outcome_sync_allowed, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_id) DO UPDATE SET
             discovery_allowed = excluded.discovery_allowed,
             detail_retrieval_allowed = excluded.detail_retrieval_allowed,
             assisted_submission_allowed = excluded.assisted_submission_allowed,
             autonomous_submission_allowed = excluded.autonomous_submission_allowed,
             outcome_sync_allowed = excluded.outcome_sync_allowed,
             updated_at = excluded.updated_at`,
        )
        .run(
          sourceId,
          caps.discovery ? 1 : 0,
          caps.detailRetrieval ? 1 : 0,
          caps.assistedSubmission ? 1 : 0,
          caps.autonomousSubmission ? 1 : 0,
          caps.outcomeSync ? 1 : 0,
          now,
        );
      // Operational settings are the user's, not the adapter's. A new source
      // starts DISABLED (safe startup registration — the user opts it in), and
      // re-registering an existing source must not silently flip enable/grace:
      // only fields explicitly supplied here are written.
      const existingSettings = this.sqlite
        .prepare(
          "SELECT enabled, expiration_grace_seconds FROM source_discovery_settings WHERE source_id = ?",
        )
        .get(sourceId) as
        | { enabled: 0 | 1; expiration_grace_seconds: number }
        | undefined;
      if (!existingSettings) {
        this.sqlite
          .prepare(
            `INSERT INTO source_discovery_settings (
               source_id, enabled, kill_switch_engaged, expiration_grace_seconds, updated_at
             ) VALUES (?, ?, 0, ?, ?)`,
          )
          .run(
            sourceId,
            input.enabled === true ? 1 : 0,
            input.expirationGraceSeconds ?? 0,
            now,
          );
      } else {
        const enabled =
          input.enabled === undefined ? existingSettings.enabled : input.enabled ? 1 : 0;
        const grace =
          input.expirationGraceSeconds ?? existingSettings.expiration_grace_seconds;
        this.sqlite
          .prepare(
            `UPDATE source_discovery_settings
             SET enabled = ?, expiration_grace_seconds = ?, updated_at = ?
             WHERE source_id = ?`,
          )
          .run(enabled, grace, now, sourceId);
      }
      this.sqlite
        .prepare(
          `INSERT INTO source_health (source_id, consecutive_failures, updated_at)
           VALUES (?, 0, ?)
           ON CONFLICT(source_id) DO NOTHING`,
        )
        .run(sourceId, now);
      this.auditDiscovery(this.sqlite, "discovery_source_registered", now, {
        sourceKey: input.sourceKey,
      });
      return sourceId;
    })();
  }

  private requireSource(sourceKey: string): SourceRow {
    const row = this.sqlite
      .prepare(
        `SELECT s.id,
                COALESCE(p.discovery_allowed, 0) AS discovery_allowed,
                sds.enabled, sds.kill_switch_engaged, sds.expiration_grace_seconds
         FROM job_sources s
         JOIN source_discovery_settings sds ON sds.source_id = s.id
         LEFT JOIN source_policies p ON p.source_id = s.id
         WHERE s.source_key = ?`,
      )
      .get(sourceKey) as SourceRow | undefined;
    if (!row) throw new UnknownSourceError(sourceKey);
    return row;
  }

  setSourceEnabled(sourceKey: string, enabled: boolean, now?: string): void {
    const at = iso(now);
    this.sqlite.transaction(() => {
      const source = this.requireSource(sourceKey);
      this.sqlite
        .prepare(
          "UPDATE source_discovery_settings SET enabled = ?, updated_at = ? WHERE source_id = ?",
        )
        .run(enabled ? 1 : 0, at, source.id);
      this.auditDiscovery(this.sqlite, "discovery_source_enable_changed", at, {
        sourceKey,
        enabled,
      });
    })();
  }

  engageKillSwitch(sourceKey: string, engaged: boolean, now?: string): void {
    const at = iso(now);
    this.sqlite.transaction(() => {
      const source = this.requireSource(sourceKey);
      this.sqlite
        .prepare(
          "UPDATE source_discovery_settings SET kill_switch_engaged = ?, updated_at = ? WHERE source_id = ?",
        )
        .run(engaged ? 1 : 0, at, source.id);
      this.auditDiscovery(this.sqlite, "discovery_kill_switch_changed", at, {
        sourceKey,
        engaged,
      });
    })();
  }

  private globallyPaused(): boolean {
    const row = this.sqlite
      .prepare("SELECT globally_paused FROM automation_settings WHERE singleton_id = 1")
      .get() as { globally_paused: 0 | 1 };
    return Boolean(row.globally_paused);
  }

  startRun(input: {
    sourceKey: string;
    authoritative: boolean;
    trigger: "manual" | "scheduled" | "test";
    now?: string;
  }): string {
    const at = iso(input.now);
    const source = this.requireSource(input.sourceKey);
    const runId = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO discovery_runs (
           id, source_id, trigger, authoritative, status, started_at
         ) VALUES (?, ?, ?, ?, 'running', ?)`,
      )
      .run(runId, source.id, input.trigger, input.authoritative ? 1 : 0, at);
    return runId;
  }

  /**
   * Record a run that never executed because the gate denied it. Kept in history
   * so a refusal is inspectable.
   */
  recordSkippedRun(input: {
    sourceId: string;
    authoritative: boolean;
    trigger: "manual" | "scheduled" | "test";
    reason: string;
    now: string;
  }): string {
    const runId = randomUUID();
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO discovery_runs (
             id, source_id, trigger, authoritative, status, started_at, finished_at, skip_reason
           ) VALUES (?, ?, ?, ?, 'skipped', ?, ?, ?)`,
        )
        .run(
          runId,
          input.sourceId,
          input.trigger,
          input.authoritative ? 1 : 0,
          input.now,
          input.now,
          input.reason,
        );
      this.updateHealthForRun(input.sourceId, runId, "skipped", input.now);
      this.auditDiscovery(this.sqlite, "discovery_run_skipped", input.now, {
        reason: input.reason,
      });
    })();
    return runId;
  }

  /**
   * Atomically ingest one normalized posting. All writes for the posting happen
   * in a single transaction, so a failed write leaves nothing behind.
   */
  ingestPosting(runId: string, posting: NormalizedPosting, now?: string): IngestResult | null {
    const at = iso(now);
    return this.sqlite.transaction(() => {
      const run = this.sqlite
        .prepare("SELECT source_id, status FROM discovery_runs WHERE id = ?")
        .get(runId) as { source_id: string; status: string } | undefined;
      if (!run) throw new Error(`Discovery run ${runId} was not found.`);
      if (run.status !== "running") {
        throw new Error(`Discovery run ${runId} is not running; it cannot ingest.`);
      }
      const sourceId = run.source_id;

      // Deterministic exact dedup, scoped to this source: same
      // (source, source_job_id), else the same canonical URL under the same
      // source. Nothing else auto-merges.
      let job: { id: string } | undefined;
      if (posting.sourceJobId !== null) {
        job = this.sqlite
          .prepare("SELECT id FROM jobs WHERE source_id = ? AND source_job_id = ?")
          .get(sourceId, posting.sourceJobId) as { id: string } | undefined;
      }
      if (!job && posting.canonicalUrl !== null) {
        job = this.sqlite
          .prepare("SELECT id FROM jobs WHERE canonical_url = ? AND source_id = ?")
          .get(posting.canonicalUrl, sourceId) as { id: string } | undefined;
      }

      // A different source already owns this exact canonical URL. Merging would
      // silently transfer ownership (and let one source's authoritative sweep
      // expire a job another source just observed), so we do NOT merge across
      // sources: record the collision for inspection and skip. A source-posting
      // identity relation (multiple identities per job) is deferred to 2B.
      if (!job && posting.canonicalUrl !== null) {
        const foreign = this.sqlite
          .prepare("SELECT id, source_id FROM jobs WHERE canonical_url = ?")
          .get(posting.canonicalUrl) as { id: string; source_id: string } | undefined;
        if (foreign) {
          this.auditDiscovery(this.sqlite, "discovery_cross_source_canonical_skipped", at, {
            runId,
            sourceId,
            matchedJobId: foreign.id,
            matchedSourceId: foreign.source_id,
          });
          return null;
        }
      }

      const isNewJob = !job;
      let jobId: string;
      if (job) {
        jobId = job.id;
        this.sqlite
          .prepare("UPDATE jobs SET last_seen_at = ? WHERE id = ?")
          .run(at, jobId);
        // Re-seeing revives a previously expired job and refreshes last-seen.
        this.sqlite
          .prepare(
            `UPDATE job_discovery_state
             SET last_seen_run_id = ?, last_seen_at = ?,
                 expired = 0, expired_at = NULL, expired_by_run_id = NULL
             WHERE job_id = ?`,
          )
          .run(runId, at, jobId);
      } else {
        jobId = randomUUID();
        const organizationId = this.upsertOrganization(posting.company, at);
        this.sqlite
          .prepare(
            `INSERT INTO jobs (
               id, source_id, source_job_id, canonical_url, organization_id,
               discovered_at, last_seen_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            jobId,
            sourceId,
            posting.sourceJobId,
            posting.canonicalUrl,
            organizationId,
            at,
            at,
          );
        this.sqlite
          .prepare(
            `INSERT INTO job_discovery_state (
               job_id, source_id, fingerprint, first_seen_run_id, last_seen_run_id, last_seen_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(jobId, sourceId, posting.fingerprint, runId, runId, at);
        this.recordDuplicateCandidates(jobId, posting.fingerprint, runId, at);
      }

      // Snapshot: only when content is new for this job.
      const existingSnapshot = this.sqlite
        .prepare("SELECT id FROM job_snapshots WHERE job_id = ? AND content_hash = ?")
        .get(jobId, posting.contentHash) as { id: string } | undefined;
      let snapshotId: string;
      let isNewSnapshot: boolean;
      if (existingSnapshot) {
        snapshotId = existingSnapshot.id;
        isNewSnapshot = false;
      } else {
        snapshotId = randomUUID();
        isNewSnapshot = true;
        this.sqlite
          .prepare(
            `INSERT INTO job_snapshots (
               id, job_id, content_hash, title, location_text, workplace_type,
               employment_type, description_text, posted_at, closes_at, captured_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            snapshotId,
            jobId,
            posting.contentHash,
            posting.title,
            posting.locationText,
            posting.workplaceType,
            posting.employmentType,
            posting.descriptionText,
            posting.postedAt,
            posting.closesAt,
            at,
          );
      }

      // One observation per job per run (UNIQUE run_id, job_id).
      this.sqlite
        .prepare(
          `INSERT INTO posting_observations (
             id, run_id, job_id, job_snapshot_id, observed_at, content_changed
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), runId, jobId, snapshotId, at, isNewSnapshot ? 1 : 0);

      return { jobId, snapshotId, isNewJob, isNewSnapshot };
    })();
  }

  private upsertOrganization(company: string, now: string): string {
    const normalized = normalizeOrganizationName(company);
    const existing = this.sqlite
      .prepare("SELECT id FROM organizations WHERE normalized_name = ?")
      .get(normalized) as { id: string } | undefined;
    if (existing) return existing.id;
    const organizationId = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO organizations (id, normalized_name, display_name, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(organizationId, normalized, company.trim(), now);
    return organizationId;
  }

  private recordDuplicateCandidates(
    jobId: string,
    fingerprint: string,
    runId: string,
    now: string,
  ): void {
    const matches = this.sqlite
      .prepare(
        "SELECT job_id FROM job_discovery_state WHERE fingerprint = ? AND job_id != ?",
      )
      .all(fingerprint, jobId) as Array<{ job_id: string }>;
    if (matches.length === 0) return;
    const status = matches.length > 1 ? "ambiguous" : "candidate";
    const insert = this.sqlite.prepare(
      `INSERT INTO job_duplicate_links (
         id, job_id, matched_job_id, fingerprint, match_type, status, discovery_run_id, created_at
       ) VALUES (?, ?, ?, ?, 'fingerprint', ?, ?, ?)`,
    );
    for (const match of matches) {
      insert.run(randomUUID(), jobId, match.job_id, fingerprint, status, runId, now);
    }
  }

  private updateHealthForRun(
    sourceId: string,
    runId: string,
    status: "succeeded" | "partial" | "failed" | "skipped",
    now: string,
  ): void {
    const isFailure = status === "failed";
    const successAt = status === "succeeded" ? now : null;
    this.sqlite
      .prepare(
        `UPDATE source_health
         SET last_run_id = ?, last_status = ?, last_run_at = ?,
             last_success_at = COALESCE(?, last_success_at),
             consecutive_failures = CASE WHEN ? = 1 THEN consecutive_failures + 1 ELSE 0 END,
             updated_at = ?
         WHERE source_id = ?`,
      )
      .run(runId, status, now, successAt, isFailure ? 1 : 0, now, sourceId);
  }

  /**
   * Finish a run: record counts and failures, update health, and — only for a
   * successful authoritative run — expire jobs unseen beyond the grace period.
   */
  finishRun(input: {
    runId: string;
    status: "succeeded" | "partial" | "failed";
    /** The run's *effective* authoritative value (requested && adapter-reported). */
    authoritative: boolean;
    postingsSeen: number;
    newJobs: number;
    newSnapshots: number;
    failures: readonly ClassifiedFailure[];
    now: string;
  }): { expiredJobs: number } {
    return this.sqlite.transaction(() => {
      const run = this.sqlite
        .prepare("SELECT source_id, status FROM discovery_runs WHERE id = ?")
        .get(input.runId) as { source_id: string; status: string } | undefined;
      if (!run) throw new Error(`Discovery run ${input.runId} was not found.`);
      if (run.status !== "running") {
        throw new Error(`Discovery run ${input.runId} is already finalized.`);
      }

      let expiredJobs = 0;
      // Expiration is allowed only after a successful, *effectively* authoritative
      // run — an adapter that downgraded authority must not trigger expiration.
      if (input.status === "succeeded" && input.authoritative) {
        expiredJobs = this.expireStaleJobs(run.source_id, input.runId, input.now);
      }

      // Sanitize every entry to a well-formed classified failure: unknown
      // categories and malformed values (null, strings, empty objects) collapse
      // to 'internal', and the message is regenerated so nothing an adapter put
      // in a message can be persisted — and a malformed entry can never throw
      // here and leave the run stuck 'running'.
      input.failures.forEach((failure, ordinal) => {
        const safe = sanitizeClassifiedFailure(failure);
        this.sqlite
          .prepare(
            `INSERT INTO discovery_run_failures (run_id, failure_ordinal, category, message)
             VALUES (?, ?, ?, ?)`,
          )
          .run(input.runId, ordinal, safe.category, safe.message);
      });

      this.sqlite
        .prepare(
          `UPDATE discovery_runs
           SET status = ?, finished_at = ?, authoritative = ?, postings_seen = ?,
               new_jobs = ?, new_snapshots = ?, failure_count = ?, expired_jobs = ?
           WHERE id = ?`,
        )
        .run(
          input.status,
          input.now,
          input.authoritative ? 1 : 0,
          input.postingsSeen,
          input.newJobs,
          input.newSnapshots,
          input.failures.length,
          expiredJobs,
          input.runId,
        );

      this.updateHealthForRun(run.source_id, input.runId, input.status, input.now);
      this.auditDiscovery(this.sqlite, "discovery_run_finished", input.now, {
        status: input.status,
        expiredJobs,
        failureCount: input.failures.length,
      });
      return { expiredJobs };
    })();
  }

  private expireStaleJobs(sourceId: string, runId: string, now: string): number {
    const graceRow = this.sqlite
      .prepare("SELECT expiration_grace_seconds FROM source_discovery_settings WHERE source_id = ?")
      .get(sourceId) as { expiration_grace_seconds: number };
    const cutoff = new Date(
      new Date(now).getTime() - graceRow.expiration_grace_seconds * 1000,
    ).toISOString();
    const result = this.sqlite
      .prepare(
        `UPDATE job_discovery_state
         SET expired = 1, expired_at = ?, expired_by_run_id = ?
         WHERE source_id = ? AND expired = 0
           AND last_seen_run_id != ? AND last_seen_at < ?`,
      )
      .run(now, runId, sourceId, runId, cutoff);
    return result.changes;
  }

  // ---- Read model (consumed by the Phase 2D UI later; no IPC channel yet) ----

  listRuns(filter?: { sourceKey?: string; limit?: number }): DiscoveryRunView[] {
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 500);
    const rows = this.sqlite
      .prepare(
        `SELECT r.id, s.source_key, r.trigger, r.authoritative, r.status,
                r.started_at, r.finished_at, r.postings_seen, r.new_jobs,
                r.new_snapshots, r.failure_count, r.expired_jobs, r.skip_reason
         FROM discovery_runs r
         JOIN job_sources s ON s.id = r.source_id
         WHERE (:sourceKey IS NULL OR s.source_key = :sourceKey)
         ORDER BY r.started_at DESC, r.id
         LIMIT :limit`,
      )
      .all({ sourceKey: filter?.sourceKey ?? null, limit }) as Array<{
      id: string;
      source_key: string;
      trigger: string;
      authoritative: 0 | 1;
      status: DiscoveryRunView["status"];
      started_at: string;
      finished_at: string | null;
      postings_seen: number;
      new_jobs: number;
      new_snapshots: number;
      failure_count: number;
      expired_jobs: number;
      skip_reason: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sourceKey: row.source_key,
      trigger: row.trigger,
      authoritative: Boolean(row.authoritative),
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      postingsSeen: row.postings_seen,
      newJobs: row.new_jobs,
      newSnapshots: row.new_snapshots,
      failureCount: row.failure_count,
      expiredJobs: row.expired_jobs,
      skipReason: row.skip_reason,
    }));
  }

  getSourceHealth(sourceKey: string): SourceHealthView | null {
    const row = this.sqlite
      .prepare(
        `SELECT s.source_key, sds.enabled, sds.kill_switch_engaged,
                h.last_status, h.last_run_at, h.last_success_at, h.consecutive_failures
         FROM job_sources s
         JOIN source_discovery_settings sds ON sds.source_id = s.id
         JOIN source_health h ON h.source_id = s.id
         WHERE s.source_key = ?`,
      )
      .get(sourceKey) as
      | {
          source_key: string;
          enabled: 0 | 1;
          kill_switch_engaged: 0 | 1;
          last_status: string | null;
          last_run_at: string | null;
          last_success_at: string | null;
          consecutive_failures: number;
        }
      | undefined;
    if (!row) return null;
    return {
      sourceKey: row.source_key,
      enabled: Boolean(row.enabled),
      killSwitchEngaged: Boolean(row.kill_switch_engaged),
      lastStatus: row.last_status,
      lastRunAt: row.last_run_at,
      lastSuccessAt: row.last_success_at,
      consecutiveFailures: row.consecutive_failures,
    };
  }

  listDuplicateLinks(jobId: string): DuplicateLinkView[] {
    const rows = this.sqlite
      .prepare(
        `SELECT job_id, matched_job_id, fingerprint, match_type, status, created_at
         FROM job_duplicate_links
         WHERE job_id = ? OR matched_job_id = ?
         ORDER BY created_at DESC, id`,
      )
      .all(jobId, jobId) as Array<{
      job_id: string;
      matched_job_id: string;
      fingerprint: string;
      match_type: string;
      status: "candidate" | "ambiguous";
      created_at: string;
    }>;
    return rows.map((row) => ({
      jobId: row.job_id,
      matchedJobId: row.matched_job_id,
      fingerprint: row.fingerprint,
      matchType: row.match_type,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  /** Gate inputs for a source, or null when the source is not registered. */
  readGateInput(sourceKey: string): {
    sourceId: string;
    gate: ReturnType<typeof evaluateDiscoveryGate>;
  } | null {
    let source: SourceRow;
    try {
      source = this.requireSource(sourceKey);
    } catch {
      return null;
    }
    return {
      sourceId: source.id,
      gate: evaluateDiscoveryGate({
        sourceRegistered: true,
        discoveryAllowed: source.discovery_allowed === 1,
        sourceEnabled: source.enabled === 1,
        killSwitchEngaged: source.kill_switch_engaged === 1,
        globallyPaused: this.globallyPaused(),
      }),
    };
  }
}

/**
 * Orchestrate one discovery run for an adapter. Evaluates the gate first and
 * calls the adapter only when allowed. Each posting is normalized and ingested
 * atomically; normalization and ingestion failures are classified (never carrying
 * raw content) and downgrade the run to partial/failed. A thrown adapter fails
 * the whole run — and a failed or partial run never expires jobs.
 */
export async function runDiscovery(
  database: JobAgentDatabase,
  adapter: SourceAdapter,
  options: DiscoveryRunOptions = {},
): Promise<DiscoveryResult> {
  const repository = new DiscoveryRepository(database);
  const now = iso(options.now);
  const authoritative = options.authoritative ?? false;
  const trigger = options.trigger ?? "manual";

  const gateInput = repository.readGateInput(adapter.key);
  if (!gateInput) {
    // Unregistered source: refuse without inventing a run row it can't anchor.
    return { runId: "", status: "skipped", authoritative, postings: [], failures: [] };
  }
  if (!gateInput.gate.allowed) {
    const runId = repository.recordSkippedRun({
      sourceId: gateInput.sourceId,
      authoritative,
      trigger,
      reason: gateInput.gate.reason,
      now,
    });
    return { runId, status: "skipped", authoritative, postings: [], failures: [] };
  }

  const runId = repository.startRun({
    sourceKey: adapter.key,
    authoritative,
    trigger,
    now,
  });

  const failures: ClassifiedFailure[] = [];
  const postings: NormalizedPosting[] = [];
  let newJobs = 0;
  let newSnapshots = 0;
  let collisions = 0;

  let runAuthoritative = authoritative;
  try {
    const output = await adapter.discover({
      runId,
      sourceKey: adapter.key,
      authoritative,
      now,
    });

    // Adapter output is untrusted and its shape must FAIL CLOSED: a malformed
    // response must never read as a clean authoritative crawl (which would let a
    // "successful empty crawl" expire every job). Any shape defect records a
    // safe failure and drops effective authority to false, so expiration —
    // gated on succeeded + authoritative — cannot run.
    const validOutput = output !== null && typeof output === "object";
    runAuthoritative =
      authoritative && validOutput && (output as RawDiscoveryOutput).authoritative === true;

    const rawFailuresValue = validOutput ? (output as RawDiscoveryOutput).failures : undefined;
    if (rawFailuresValue !== undefined && !Array.isArray(rawFailuresValue)) {
      failures.push({ category: "internal", message: safeFailureMessage("internal") });
      runAuthoritative = false;
    }
    const rawFailures = Array.isArray(rawFailuresValue) ? rawFailuresValue : [];
    for (const failure of rawFailures) failures.push(sanitizeClassifiedFailure(failure));

    const rawPostingsValue = validOutput ? (output as RawDiscoveryOutput).postings : undefined;
    if (!Array.isArray(rawPostingsValue)) {
      // Missing/non-array postings: we cannot trust "saw nothing" — treat it as
      // a schema fault, not an empty crawl.
      failures.push({ category: "schema", message: safeFailureMessage("schema") });
      runAuthoritative = false;
    }
    const rawPostings = Array.isArray(rawPostingsValue) ? rawPostingsValue : [];

    for (const raw of rawPostings) {
      const normalized = normalizePosting(raw);
      if (!normalized.ok) {
        failures.push(normalized.failure);
        continue;
      }
      try {
        const result = repository.ingestPosting(runId, normalized.posting, now);
        if (result === null) {
          // A cross-source canonical duplicate we deliberately did not merge.
          // It is dropped source data, so it is a safe classified failure — the
          // run must not report a clean success or expire jobs on its basis.
          collisions += 1;
          failures.push({
            category: "cross_source_duplicate",
            message: safeFailureMessage("cross_source_duplicate"),
          });
          continue;
        }
        postings.push(normalized.posting);
        if (result.isNewJob) newJobs += 1;
        if (result.isNewSnapshot) newSnapshots += 1;
      } catch (error) {
        failures.push(classifyFailure(error));
      }
    }
  } catch (error) {
    // Adapter blew up: fail the run. finishRun('failed') never expires jobs.
    failures.push(classifyFailure(error));
    repository.finishRun({
      runId,
      status: "failed",
      authoritative: false,
      postingsSeen: postings.length,
      newJobs,
      newSnapshots,
      failures,
      now,
    });
    return { runId, status: "failed", authoritative: false, postings, failures };
  }

  // A clean run succeeds. Any ingested posting or dropped cross-source duplicate
  // makes an otherwise-failing run partial (a duplicate is benign, so it must
  // not fail the run — but it must stop it succeeding). Only hard failures with
  // nothing ingested fail outright.
  const status: "succeeded" | "partial" | "failed" =
    failures.length === 0
      ? "succeeded"
      : postings.length > 0 || collisions > 0
        ? "partial"
        : "failed";

  repository.finishRun({
    runId,
    status,
    authoritative: runAuthoritative,
    postingsSeen: postings.length,
    newJobs,
    newSnapshots,
    failures,
    now,
  });

  return { runId, status, authoritative: runAuthoritative, postings, failures };
}
