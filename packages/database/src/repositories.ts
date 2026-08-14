import { randomUUID } from "node:crypto";
import {
  assertAuthorizedTransition,
  assertOutcomeCorrection,
  type ApplicationState,
  type ApplicationTransitionCommand,
  type AutomationMode,
  type EventActor,
  type OutcomeCorrectionCommand,
} from "@us-job-agent/domain";
import type Database from "better-sqlite3";
import { getDatabaseConnection } from "./database-internal.ts";
import type { JobAgentDatabase } from "./database.ts";

type ApplicationRecord = {
  id: string;
  job_id: string;
  job_snapshot_id: string;
  source_id: string;
  current_state: ApplicationState;
  automation_mode: AutomationMode;
};

export type CreateJobInput = {
  sourceKey: string;
  sourceDisplayName: string;
  sourceJobId?: string;
  canonicalUrl?: string;
  organizationName?: string;
  title: string;
  locationText?: string;
  workplaceType: "remote" | "hybrid" | "onsite" | "unknown";
  employmentType?: string;
  descriptionText: string;
  contentHash: string;
  postedAt?: string;
  closesAt?: string;
  now?: string;
};

export type CreateApplicationInput = {
  jobId: string;
  automationMode: AutomationMode;
  actor?: EventActor;
  now?: string;
};

export type TransitionInput = {
  applicationId: string;
  command: ApplicationTransitionCommand;
  reason: string;
  correlationId?: string;
  payload?: Readonly<Record<string, unknown>>;
  now?: string;
};

function normalizeOrganizationName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function getApplication(
  sqlite: Database.Database,
  applicationId: string,
): ApplicationRecord {
  const row = sqlite
    .prepare(
      `SELECT a.id, a.job_id, a.job_snapshot_id, j.source_id,
              a.current_state, a.automation_mode
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       WHERE a.id = ?`,
    )
    .get(applicationId) as ApplicationRecord | undefined;
  if (!row) throw new Error(`Application ${applicationId} was not found.`);
  return row;
}

function nextSequence(sqlite: Database.Database, applicationId: string): number {
  const row = sqlite
    .prepare(
      `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_sequence
       FROM application_events WHERE application_id = ?`,
    )
    .get(applicationId) as { next_sequence: number };
  return row.next_sequence;
}

function assertPersistedSubmissionEvidence(
  sqlite: Database.Database,
  application: ApplicationRecord,
  command: ApplicationTransitionCommand,
): void {
  if (command.to !== "submitting") return;
  const { authorization } = command;
  if (authorization.automationMode !== application.automation_mode) {
    throw new Error("Transition automation mode does not match the application.");
  }

  const settings = sqlite
    .prepare("SELECT globally_paused FROM automation_settings WHERE singleton_id = 1")
    .get() as { globally_paused: 0 | 1 };
  if (Boolean(settings.globally_paused) !== authorization.globalAutomationPaused) {
    throw new Error("Transition pause status does not match persisted settings.");
  }

  const policy = sqlite
    .prepare(
      `SELECT assisted_submission_allowed, autonomous_submission_allowed
       FROM source_policies WHERE source_id = ?`,
    )
    .get(application.source_id) as
    | { assisted_submission_allowed: 0 | 1; autonomous_submission_allowed: 0 | 1 }
    | undefined;
  const policyAllows =
    application.automation_mode === "autonomous"
      ? Boolean(policy?.autonomous_submission_allowed)
      : Boolean(policy?.assisted_submission_allowed);
  if (policyAllows !== authorization.sourceSubmissionAllowed) {
    throw new Error("Transition source policy does not match persisted policy.");
  }

  const approval = sqlite
    .prepare(
      `SELECT approval_kind, approved_by FROM application_approvals
       WHERE application_id = ? AND approval_reference = ?`,
    )
    .get(application.id, authorization.approval?.reference ?? "") as
    | { approval_kind: string; approved_by: string }
    | undefined;
  if (
    !approval ||
    approval.approval_kind !== authorization.approval?.kind ||
    approval.approved_by !== authorization.approval.approvedBy
  ) {
    throw new Error("Submission approval reference is not recorded for this application.");
  }

  const verification = sqlite
    .prepare(
      `SELECT result FROM verification_results
       WHERE application_id = ? AND verification_reference = ?`,
    )
    .get(application.id, authorization.verification.reference ?? "") as
    | { result: string }
    | undefined;
  if (!verification || verification.result !== authorization.verification.result) {
    throw new Error("Verification reference is not recorded for this application.");
  }
}

function assertPersistedEligibilityEvidence(
  sqlite: Database.Database,
  application: ApplicationRecord,
  command: ApplicationTransitionCommand,
): void {
  const isInitialDecision =
    command.from === "normalized" &&
    (command.to === "eligible" ||
      command.to === "hard_stopped" ||
      command.to === "needs_review");
  const isReviewResolution =
    command.from === "needs_review" &&
    (command.to === "eligible" || command.to === "hard_stopped");
  if (!isInitialDecision && !isReviewResolution) {
    return;
  }

  const assessmentReference =
    command.authorization.eligibilityAssessmentReference?.trim() ?? "";
  const assessment = sqlite
    .prepare(
      `SELECT ea.status
       FROM eligibility_assessments ea
       JOIN requirement_extractions extraction ON extraction.id = ea.extraction_id
       WHERE ea.id = ? AND extraction.job_snapshot_id = ?`,
    )
    .get(assessmentReference, application.job_snapshot_id) as
    | { status: "eligible" | "blocked" | "needs_review" }
    | undefined;
  const requiredStatus =
    command.to === "hard_stopped" ? "blocked" : command.to;
  if (!assessment || assessment.status !== requiredStatus) {
    throw new Error(
      `Eligibility assessment must exist for this application's posting snapshot and have status ${requiredStatus}.`,
    );
  }

  if (isReviewResolution && command.to === "eligible") {
    throw new Error(
      "Candidate-fact review resolution is unavailable until candidate facts have a persisted, verifiable ledger.",
    );
  }
}

export class JobRepository {
  constructor(private readonly database: JobAgentDatabase) {}

  private get sqlite(): Database.Database {
    return getDatabaseConnection(this.database);
  }

  createWithSnapshot(input: CreateJobInput): { jobId: string; snapshotId: string } {
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const source = this.sqlite
        .prepare("SELECT id FROM job_sources WHERE source_key = ?")
        .get(input.sourceKey) as { id: string } | undefined;
      const sourceId = source?.id ?? randomUUID();
      if (!source) {
        this.sqlite
          .prepare(
            `INSERT INTO job_sources (id, source_key, display_name, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(sourceId, input.sourceKey, input.sourceDisplayName, now);
      }

      let organizationId: string | null = null;
      if (input.organizationName) {
        const normalized = normalizeOrganizationName(input.organizationName);
        const existing = this.sqlite
          .prepare("SELECT id FROM organizations WHERE normalized_name = ?")
          .get(normalized) as { id: string } | undefined;
        organizationId = existing?.id ?? randomUUID();
        if (!existing) {
          this.sqlite
            .prepare(
              `INSERT INTO organizations (id, normalized_name, display_name, created_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(organizationId, normalized, input.organizationName.trim(), now);
        }
      }

      const jobId = randomUUID();
      const snapshotId = randomUUID();
      this.sqlite
        .prepare(
          `INSERT INTO jobs (
             id, source_id, source_job_id, canonical_url, organization_id, discovered_at, last_seen_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          sourceId,
          input.sourceJobId ?? null,
          input.canonicalUrl ?? null,
          organizationId,
          now,
          now,
        );
      this.sqlite
        .prepare(
          `INSERT INTO job_snapshots (
             id, job_id, content_hash, title, location_text, workplace_type, employment_type,
             description_text, posted_at, closes_at, captured_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshotId,
          jobId,
          input.contentHash,
          input.title,
          input.locationText ?? null,
          input.workplaceType,
          input.employmentType ?? null,
          input.descriptionText,
          input.postedAt ?? null,
          input.closesAt ?? null,
          now,
        );
      return { jobId, snapshotId };
    })();
  }
}

export class ApplicationRepository {
  constructor(private readonly database: JobAgentDatabase) {}

  private get sqlite(): Database.Database {
    return getDatabaseConnection(this.database);
  }

  create(input: CreateApplicationInput): string {
    const now = input.now ?? new Date().toISOString();
    const applicationId = randomUUID();
    this.sqlite.transaction(() => {
      const attempt = this.sqlite
        .prepare(
          "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt FROM applications WHERE job_id = ?",
        )
        .get(input.jobId) as { attempt: number };
      const snapshot = this.sqlite
        .prepare(
          `SELECT id FROM job_snapshots
           WHERE job_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1`,
        )
        .get(input.jobId) as { id: string } | undefined;
      if (!snapshot) {
        throw new Error(`Job ${input.jobId} has no posting snapshot.`);
      }
      this.sqlite
        .prepare(
          `INSERT INTO applications (
             id, job_id, job_snapshot_id, attempt_number, current_state,
             automation_mode, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'discovered', ?, ?, ?)`,
        )
        .run(
          applicationId,
          input.jobId,
          snapshot.id,
          attempt.attempt,
          input.automationMode,
          now,
          now,
        );
      this.sqlite
        .prepare(
          `INSERT INTO application_events (
             id, application_id, sequence_number, event_type, actor, from_state, to_state,
             occurred_at, reason, payload_json
           ) VALUES (?, ?, 1, 'application_created', ?, NULL, 'discovered', ?, ?, '{}')`,
        )
        .run(randomUUID(), applicationId, input.actor ?? "system", now, "Application created.");
    })();
    return applicationId;
  }

  recordApproval(input: {
    applicationId: string;
    kind: "human" | "policy";
    approvedBy: "user" | "system";
    reference: string;
    now?: string;
  }): void {
    this.sqlite
      .prepare(
        `INSERT INTO application_approvals (
           id, application_id, approval_kind, approved_by, approval_reference, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.applicationId,
        input.kind,
        input.approvedBy,
        input.reference,
        input.now ?? new Date().toISOString(),
      );
  }

  recordVerification(input: {
    applicationId: string;
    reference: string;
    result: "passed" | "failed";
    now?: string;
  }): void {
    this.sqlite
      .prepare(
        `INSERT INTO verification_results (
           id, application_id, verification_reference, result, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.applicationId,
        input.reference,
        input.result,
        input.now ?? new Date().toISOString(),
      );
  }

  transition(input: TransitionInput): string {
    if (!input.reason.trim()) throw new Error("A transition reason is required.");
    assertAuthorizedTransition(input.command);
    const now = input.now ?? new Date().toISOString();

    return this.sqlite.transaction(() => {
      const application = getApplication(this.sqlite, input.applicationId);
      if (application.current_state !== input.command.from) {
        throw new Error(
          `Stale application state: expected ${input.command.from}, found ${application.current_state}.`,
        );
      }
      assertPersistedEligibilityEvidence(this.sqlite, application, input.command);
      assertPersistedSubmissionEvidence(this.sqlite, application, input.command);

      const eventId = randomUUID();
      this.sqlite
        .prepare(
          `INSERT INTO application_events (
             id, application_id, sequence_number, event_type, actor, from_state, to_state,
             occurred_at, reason, correlation_id, idempotency_key, payload_json
           ) VALUES (?, ?, ?, 'state_transition', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          application.id,
          nextSequence(this.sqlite, application.id),
          input.command.authorization.actor,
          input.command.from,
          input.command.to,
          now,
          input.reason,
          input.correlationId ?? null,
          input.command.authorization.idempotencyKey ?? null,
          JSON.stringify(input.payload ?? {}),
        );
      this.sqlite
        .prepare("UPDATE applications SET current_state = ?, updated_at = ? WHERE id = ?")
        .run(input.command.to, now, application.id);
      return eventId;
    })();
  }

  correctOutcome(input: {
    applicationId: string;
    command: OutcomeCorrectionCommand;
    now?: string;
  }): string {
    assertOutcomeCorrection(input.command);
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const application = getApplication(this.sqlite, input.applicationId);
      if (application.current_state !== input.command.from) {
        throw new Error("Outcome correction does not match the current application state.");
      }
      const superseded = this.sqlite
        .prepare(
          `SELECT id FROM application_events
           WHERE id = ? AND application_id = ? AND to_state = ?
             AND sequence_number = (
               SELECT MAX(sequence_number) FROM application_events WHERE application_id = ?
             )`,
        )
        .get(
          input.command.supersededEventId,
          application.id,
          input.command.from,
          application.id,
        ) as { id: string } | undefined;
      if (!superseded) {
        throw new Error(
          "The superseded event must be the application's latest effective outcome event.",
        );
      }

      const eventId = randomUUID();
      this.sqlite
        .prepare(
          `INSERT INTO application_events (
             id, application_id, sequence_number, event_type, actor, from_state, to_state,
             occurred_at, reason, supersedes_event_id, payload_json
           ) VALUES (?, ?, ?, 'outcome_corrected', ?, ?, ?, ?, ?, ?, '{}')`,
        )
        .run(
          eventId,
          application.id,
          nextSequence(this.sqlite, application.id),
          input.command.actor,
          input.command.from,
          input.command.to,
          now,
          input.command.reason,
          input.command.supersededEventId,
        );
      this.sqlite
        .prepare("UPDATE applications SET current_state = ?, updated_at = ? WHERE id = ?")
        .run(input.command.to, now, application.id);
      return eventId;
    })();
  }

  rebuildCurrentState(applicationId: string): ApplicationState {
    const events = this.sqlite
      .prepare(
        `SELECT from_state, to_state FROM application_events
         WHERE application_id = ? ORDER BY sequence_number`,
      )
      .all(applicationId) as Array<{
      from_state: ApplicationState | null;
      to_state: ApplicationState;
    }>;
    if (events.length === 0 || events[0]?.from_state !== null) {
      throw new Error("Application event stream has no creation event.");
    }
    let state = events[0].to_state;
    for (const event of events.slice(1)) {
      if (event.from_state !== state) {
        throw new Error("Application event stream is not contiguous.");
      }
      state = event.to_state;
    }
    return state;
  }
}
