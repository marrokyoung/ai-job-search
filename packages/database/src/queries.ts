import type {
  ApplicationState,
  AutomationMode,
  EligibilityStatus,
  EventActor,
  RequirementCategory,
  RequirementSeverity,
} from "@us-job-agent/domain";
import type Database from "better-sqlite3";
import { getDatabaseConnection } from "./database-internal.ts";
import type { JobAgentDatabase } from "./database.ts";

export type WorkplaceType = "remote" | "hybrid" | "onsite" | "unknown";

export type JobSummary = {
  jobId: string;
  sourceKey: string;
  sourceDisplayName: string;
  organizationName: string | null;
  canonicalUrl: string | null;
  snapshotId: string;
  title: string;
  locationText: string | null;
  workplaceType: WorkplaceType;
  employmentType: string | null;
  capturedAt: string;
  eligibilityStatus: EligibilityStatus | null;
  softGapCount: number;
  applicationId: string | null;
  applicationState: ApplicationState | null;
};

export type JobRequirementAssessmentView = {
  requirementText: string;
  category: RequirementCategory;
  severity: RequirementSeverity;
  mandatory: boolean;
  explanation: string;
};

export type JobDetail = {
  job: JobSummary;
  descriptionText: string;
  assessments: readonly JobRequirementAssessmentView[];
};

export type JobListFilter = {
  eligibility?: EligibilityStatus;
  limit?: number;
};

export type ApplicationSummary = {
  applicationId: string;
  jobId: string;
  jobTitle: string;
  organizationName: string | null;
  currentState: ApplicationState;
  automationMode: AutomationMode;
  attemptNumber: number;
  createdAt: string;
  updatedAt: string;
};

export type ApplicationListFilter = {
  state?: ApplicationState;
  limit?: number;
};

export type ApplicationDetail = {
  application: ApplicationSummary;
  /** The posting snapshot this application is pinned to. */
  jobSnapshotId: string;
  latestEvent: ApplicationTimelineEvent;
};

export type ApplicationTimelineEvent = {
  eventId: string;
  applicationId: string;
  sequenceNumber: number;
  eventType: string;
  actor: EventActor;
  fromState: ApplicationState | null;
  toState: ApplicationState;
  occurredAt: string;
  reason: string;
  correlationId: string | null;
  supersedesEventId: string | null;
};

export type DashboardMetrics = {
  applicationStateCounts: ReadonlyArray<{ state: ApplicationState; count: number }>;
  openReviewItemCount: number;
  automationPaused: boolean;
  recentEvents: readonly ApplicationTimelineEvent[];
};

const defaultListLimit = 100;
const maxListLimit = 500;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return defaultListLimit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("List limit must be a positive integer.");
  }
  return Math.min(limit, maxListLimit);
}

type JobSummaryRow = {
  job_id: string;
  source_key: string;
  source_display_name: string;
  organization_name: string | null;
  canonical_url: string | null;
  snapshot_id: string;
  title: string;
  location_text: string | null;
  workplace_type: WorkplaceType;
  employment_type: string | null;
  captured_at: string;
  eligibility_status: EligibilityStatus | null;
  soft_gap_count: number;
  application_id: string | null;
  application_state: ApplicationState | null;
};

type TimelineEventRow = {
  event_id: string;
  application_id: string;
  sequence_number: number;
  event_type: string;
  actor: EventActor;
  from_state: ApplicationState | null;
  to_state: ApplicationState;
  occurred_at: string;
  reason: string;
  correlation_id: string | null;
  supersedes_event_id: string | null;
};

const jobSummarySelect = `
  SELECT j.id AS job_id,
         s.source_key,
         s.display_name AS source_display_name,
         o.display_name AS organization_name,
         j.canonical_url,
         snap.id AS snapshot_id,
         snap.title,
         snap.location_text,
         snap.workplace_type,
         snap.employment_type,
         snap.captured_at,
         ea.status AS eligibility_status,
         COALESCE((
           SELECT COUNT(*) FROM requirement_assessments ra
           WHERE ra.eligibility_assessment_id = ea.id AND ra.severity = 'soft_gap'
         ), 0) AS soft_gap_count,
         app.id AS application_id,
         app.current_state AS application_state
  FROM jobs j
  JOIN job_sources s ON s.id = j.source_id
  LEFT JOIN organizations o ON o.id = j.organization_id
  JOIN job_snapshots snap ON snap.id = (
    SELECT id FROM job_snapshots
    WHERE job_id = j.id
    ORDER BY captured_at DESC, id DESC
    LIMIT 1
  )
  LEFT JOIN eligibility_assessments ea ON ea.id = (
    SELECT ea2.id
    FROM eligibility_assessments ea2
    JOIN requirement_extractions ex ON ex.id = ea2.extraction_id
    WHERE ex.job_snapshot_id = snap.id
    ORDER BY ea2.created_at DESC, ea2.id DESC
    LIMIT 1
  )
  LEFT JOIN applications app ON app.id = (
    SELECT id FROM applications
    WHERE job_id = j.id
    ORDER BY attempt_number DESC
    LIMIT 1
  )
`;

function toJobSummary(row: JobSummaryRow): JobSummary {
  return {
    jobId: row.job_id,
    sourceKey: row.source_key,
    sourceDisplayName: row.source_display_name,
    organizationName: row.organization_name,
    canonicalUrl: row.canonical_url,
    snapshotId: row.snapshot_id,
    title: row.title,
    locationText: row.location_text,
    workplaceType: row.workplace_type,
    employmentType: row.employment_type,
    capturedAt: row.captured_at,
    eligibilityStatus: row.eligibility_status,
    softGapCount: row.soft_gap_count,
    applicationId: row.application_id,
    applicationState: row.application_state,
  };
}

type ApplicationSummaryRow = {
  application_id: string;
  job_id: string;
  job_snapshot_id: string;
  job_title: string;
  organization_name: string | null;
  current_state: ApplicationState;
  automation_mode: AutomationMode;
  attempt_number: number;
  created_at: string;
  updated_at: string;
};

const applicationSummarySelect = `
  SELECT a.id AS application_id, a.job_id, a.job_snapshot_id, snap.title AS job_title,
         o.display_name AS organization_name, a.current_state, a.automation_mode,
         a.attempt_number, a.created_at, a.updated_at
  FROM applications a
  JOIN jobs j ON j.id = a.job_id
  JOIN job_snapshots snap ON snap.id = a.job_snapshot_id
  LEFT JOIN organizations o ON o.id = j.organization_id
`;

function toApplicationSummary(row: ApplicationSummaryRow): ApplicationSummary {
  return {
    applicationId: row.application_id,
    jobId: row.job_id,
    jobTitle: row.job_title,
    organizationName: row.organization_name,
    currentState: row.current_state,
    automationMode: row.automation_mode,
    attemptNumber: row.attempt_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTimelineEvent(row: TimelineEventRow): ApplicationTimelineEvent {
  return {
    eventId: row.event_id,
    applicationId: row.application_id,
    sequenceNumber: row.sequence_number,
    eventType: row.event_type,
    actor: row.actor,
    fromState: row.from_state,
    toState: row.to_state,
    occurredAt: row.occurred_at,
    reason: row.reason,
    correlationId: row.correlation_id,
    supersedesEventId: row.supersedes_event_id,
  };
}

export class ReadModelQueries {
  constructor(private readonly database: JobAgentDatabase) {}

  private get sqlite(): Database.Database {
    return getDatabaseConnection(this.database);
  }

  getDashboardMetrics(options?: { recentEventLimit?: number }): DashboardMetrics {
    const stateRows = this.sqlite
      .prepare(
        `SELECT current_state AS state, COUNT(*) AS count
         FROM applications GROUP BY current_state ORDER BY current_state`,
      )
      .all() as Array<{ state: ApplicationState; count: number }>;
    const reviewRow = this.sqlite
      .prepare("SELECT COUNT(*) AS count FROM review_items WHERE status = 'open'")
      .get() as { count: number };
    const settingsRow = this.sqlite
      .prepare("SELECT globally_paused FROM automation_settings WHERE singleton_id = 1")
      .get() as { globally_paused: 0 | 1 };
    const eventRows = this.sqlite
      .prepare(
        `SELECT id AS event_id, application_id, sequence_number, event_type, actor,
                from_state, to_state, occurred_at, reason, correlation_id, supersedes_event_id
         FROM application_events
         ORDER BY occurred_at DESC, application_id, sequence_number DESC
         LIMIT ?`,
      )
      .all(clampLimit(options?.recentEventLimit ?? 20)) as TimelineEventRow[];
    return {
      applicationStateCounts: stateRows,
      openReviewItemCount: reviewRow.count,
      automationPaused: Boolean(settingsRow.globally_paused),
      recentEvents: eventRows.map(toTimelineEvent),
    };
  }

  listJobs(filter?: JobListFilter): JobSummary[] {
    const eligibility = filter?.eligibility ?? null;
    const rows = this.sqlite
      .prepare(
        `${jobSummarySelect}
         WHERE (:eligibility IS NULL OR ea.status = :eligibility)
         ORDER BY snap.captured_at DESC, j.id
         LIMIT :limit`,
      )
      .all({ eligibility, limit: clampLimit(filter?.limit) }) as JobSummaryRow[];
    return rows.map(toJobSummary);
  }

  getJobDetail(jobId: string): JobDetail | null {
    const row = this.sqlite
      .prepare(`${jobSummarySelect} WHERE j.id = ?`)
      .get(jobId) as JobSummaryRow | undefined;
    if (!row) return null;
    const description = this.sqlite
      .prepare("SELECT description_text FROM job_snapshots WHERE id = ?")
      .get(row.snapshot_id) as { description_text: string };
    const assessmentRows = row.eligibility_status === null
      ? []
      : (this.sqlite
          .prepare(
            `SELECT r.requirement_text, r.category, ra.severity, r.mandatory, ra.explanation
             FROM requirement_assessments ra
             JOIN requirements r
               ON r.id = ra.requirement_id AND r.extraction_id = ra.extraction_id
             WHERE ra.eligibility_assessment_id = (
               SELECT ea2.id
               FROM eligibility_assessments ea2
               JOIN requirement_extractions ex ON ex.id = ea2.extraction_id
               WHERE ex.job_snapshot_id = ?
               ORDER BY ea2.created_at DESC, ea2.id DESC
               LIMIT 1
             )
             ORDER BY r.requirement_ordinal`,
          )
          .all(row.snapshot_id) as Array<{
          requirement_text: string;
          category: RequirementCategory;
          severity: RequirementSeverity;
          mandatory: 0 | 1;
          explanation: string;
        }>);
    return {
      job: toJobSummary(row),
      descriptionText: description.description_text,
      assessments: assessmentRows.map((assessment) => ({
        requirementText: assessment.requirement_text,
        category: assessment.category,
        severity: assessment.severity,
        mandatory: Boolean(assessment.mandatory),
        explanation: assessment.explanation,
      })),
    };
  }

  listApplications(filter?: ApplicationListFilter): ApplicationSummary[] {
    const state = filter?.state ?? null;
    const rows = this.sqlite
      .prepare(
        `${applicationSummarySelect}
         WHERE (:state IS NULL OR a.current_state = :state)
         ORDER BY a.updated_at DESC, a.id
         LIMIT :limit`,
      )
      .all({ state, limit: clampLimit(filter?.limit) }) as ApplicationSummaryRow[];
    return rows.map(toApplicationSummary);
  }

  getApplicationDetail(applicationId: string): ApplicationDetail | null {
    const row = this.sqlite
      .prepare(`${applicationSummarySelect} WHERE a.id = ?`)
      .get(applicationId) as
      | (ApplicationSummaryRow & { job_snapshot_id: string })
      | undefined;
    if (!row) return null;
    const latestEvent = this.sqlite
      .prepare(
        `SELECT id AS event_id, application_id, sequence_number, event_type, actor,
                from_state, to_state, occurred_at, reason, correlation_id, supersedes_event_id
         FROM application_events
         WHERE application_id = ?
         ORDER BY sequence_number DESC
         LIMIT 1`,
      )
      .get(applicationId) as TimelineEventRow;
    return {
      application: toApplicationSummary(row),
      jobSnapshotId: row.job_snapshot_id,
      latestEvent: toTimelineEvent(latestEvent),
    };
  }

  getApplicationTimeline(applicationId: string): ApplicationTimelineEvent[] | null {
    const application = this.sqlite
      .prepare("SELECT id FROM applications WHERE id = ?")
      .get(applicationId) as { id: string } | undefined;
    if (!application) return null;
    const rows = this.sqlite
      .prepare(
        `SELECT id AS event_id, application_id, sequence_number, event_type, actor,
                from_state, to_state, occurred_at, reason, correlation_id, supersedes_event_id
         FROM application_events
         WHERE application_id = ?
         ORDER BY sequence_number`,
      )
      .all(applicationId) as TimelineEventRow[];
    return rows.map(toTimelineEvent);
  }
}
