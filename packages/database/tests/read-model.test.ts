import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  ApplicationRepository,
  JobRepository,
  ReadModelQueries,
  ReviewRepository,
  SettingsRepository,
  openDatabase,
  type JobAgentDatabase,
} from "../src/index.ts";
import { getDatabaseConnection } from "../src/database-internal.ts";

const openDatabases: JobAgentDatabase[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function openMemoryDatabase(): JobAgentDatabase {
  const database = openDatabase({ filename: ":memory:" });
  openDatabases.push(database);
  return database;
}

function createJob(database: JobAgentDatabase, suffix: string) {
  return new JobRepository(database).createWithSnapshot({
    sourceKey: "synthetic",
    sourceDisplayName: "Synthetic Source",
    sourceJobId: `role-${suffix}`,
    canonicalUrl: `https://example.invalid/jobs/role-${suffix}`,
    organizationName: "Example Engineering",
    title: `Automotive Engineer ${suffix}`,
    workplaceType: "hybrid",
    descriptionText: "Synthetic role requesting five years of experience.",
    contentHash: `hash-${suffix}`,
    now: `2026-01-0${suffix.length}T00:00:00.000Z`,
  });
}

function insertAssessmentWithRequirement(
  database: JobAgentDatabase,
  input: {
    snapshotId: string;
    suffix: string;
    status: "eligible" | "blocked" | "needs_review";
    severity?: "satisfied" | "soft_gap" | "hard_stop" | "unknown";
  },
): { assessmentId: string } {
  const sqlite = getDatabaseConnection(database);
  const extractionId = `extraction-${input.suffix}`;
  const assessmentId = `assessment-${input.suffix}`;
  const requirementId = `requirement-${input.suffix}`;
  sqlite
    .prepare(
      `INSERT INTO requirement_extractions (
         id, job_snapshot_id, status, coverage_confidence, source_text_hash,
         extractor_name, extractor_version, created_at
       ) VALUES (?, ?, 'complete', 1.0, ?, 'synthetic-test', 'v1', '2026-01-01T00:00:00.000Z')`,
    )
    .run(extractionId, input.snapshotId, `source-${input.suffix}`);
  sqlite
    .prepare(
      `INSERT INTO eligibility_assessments (
         id, extraction_id, status, evaluator_version, created_at
       ) VALUES (?, ?, ?, 'test-v1', '2026-01-01T00:00:00.000Z')`,
    )
    .run(assessmentId, extractionId, input.status);
  sqlite
    .prepare(
      `INSERT INTO requirements (
         id, extraction_id, requirement_ordinal, requirement_text, category,
         fulfillment, mandatory, classification_confidence, explanation
       ) VALUES (?, ?, 0, 'Five years of automotive experience.', 'experience_years',
                 'missing', 1, 0.9, 'Synthetic requirement.')`,
    )
    .run(requirementId, extractionId);
  sqlite
    .prepare(
      `INSERT INTO requirement_assessments (
         id, eligibility_assessment_id, requirement_id, extraction_id, severity, explanation
       ) VALUES (?, ?, ?, ?, ?, 'Experience gaps are soft by policy.')`,
    )
    .run(`ra-${input.suffix}`, assessmentId, requirementId, extractionId, input.severity ?? "soft_gap");
  return { assessmentId };
}

describe("read model queries", () => {
  test("lists jobs with latest snapshot, eligibility status, and soft-gap count", () => {
    const database = openMemoryDatabase();
    const queries = new ReadModelQueries(database);
    const jobA = createJob(database, "a");
    const jobB = createJob(database, "bb");
    createJob(database, "ccc");
    insertAssessmentWithRequirement(database, {
      snapshotId: jobA.snapshotId,
      suffix: "a",
      status: "eligible",
      severity: "soft_gap",
    });
    insertAssessmentWithRequirement(database, {
      snapshotId: jobB.snapshotId,
      suffix: "bb",
      status: "blocked",
      severity: "hard_stop",
    });

    const all = queries.listJobs();
    assert.equal(all.length, 3);

    const eligibleOnly = queries.listJobs({ eligibility: "eligible" });
    assert.equal(eligibleOnly.length, 1);
    assert.equal(eligibleOnly[0]?.jobId, jobA.jobId);
    assert.equal(eligibleOnly[0]?.eligibilityStatus, "eligible");
    assert.equal(eligibleOnly[0]?.softGapCount, 1);
    assert.equal(eligibleOnly[0]?.organizationName, "Example Engineering");

    const blockedOnly = queries.listJobs({ eligibility: "blocked" });
    assert.equal(blockedOnly.length, 1);
    assert.equal(blockedOnly[0]?.jobId, jobB.jobId);

    const unassessed = all.find((job) => job.eligibilityStatus === null);
    assert.ok(unassessed);
    assert.equal(unassessed.softGapCount, 0);
  });

  test("rejects a non-positive list limit", () => {
    const database = openMemoryDatabase();
    const queries = new ReadModelQueries(database);
    assert.throws(() => queries.listJobs({ limit: 0 }), /positive integer/);
    assert.throws(() => queries.listJobs({ limit: 2.5 }), /positive integer/);
  });

  test("returns job detail with requirement assessments and null for unknown jobs", () => {
    const database = openMemoryDatabase();
    const queries = new ReadModelQueries(database);
    const { jobId, snapshotId } = createJob(database, "a");
    insertAssessmentWithRequirement(database, {
      snapshotId,
      suffix: "a",
      status: "eligible",
    });

    const detail = queries.getJobDetail(jobId);
    assert.ok(detail);
    assert.equal(detail.job.jobId, jobId);
    assert.equal(detail.descriptionText, "Synthetic role requesting five years of experience.");
    assert.equal(detail.assessments.length, 1);
    assert.deepEqual(detail.assessments[0], {
      requirementText: "Five years of automotive experience.",
      category: "experience_years",
      severity: "soft_gap",
      mandatory: true,
      explanation: "Experience gaps are soft by policy.",
    });

    assert.equal(queries.getJobDetail("missing-job"), null);
  });

  test("lists applications with state filter and returns ordered timelines", () => {
    const database = openMemoryDatabase();
    const queries = new ReadModelQueries(database);
    const applications = new ApplicationRepository(database);
    const { jobId } = createJob(database, "a");
    const applicationId = applications.create({
      jobId,
      automationMode: "assisted",
      now: "2026-01-01T00:00:00.000Z",
    });
    applications.transition({
      applicationId,
      command: {
        from: "discovered",
        to: "normalized",
        authorization: {
          automationMode: "assisted",
          actor: "system",
          verification: { result: "not_run" },
          sourceSubmissionAllowed: false,
          globalAutomationPaused: true,
        },
      },
      reason: "Synthetic normalization.",
      now: "2026-01-02T00:00:00.000Z",
    });

    const normalized = queries.listApplications({ state: "normalized" });
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0]?.applicationId, applicationId);
    assert.equal(normalized[0]?.jobTitle, "Automotive Engineer a");
    assert.equal(queries.listApplications({ state: "submitted" }).length, 0);

    const detail = queries.getApplicationDetail(applicationId);
    assert.ok(detail);
    assert.equal(detail.application.applicationId, applicationId);
    assert.equal(detail.application.currentState, "normalized");
    assert.equal(detail.application.jobTitle, "Automotive Engineer a");
    assert.equal(detail.latestEvent.toState, "normalized");
    assert.equal(detail.latestEvent.sequenceNumber, 2);
    const pinnedSnapshot = getDatabaseConnection(database)
      .prepare("SELECT job_snapshot_id FROM applications WHERE id = ?")
      .get(applicationId) as { job_snapshot_id: string };
    assert.equal(detail.jobSnapshotId, pinnedSnapshot.job_snapshot_id);
    assert.equal(queries.getApplicationDetail("missing-application"), null);

    const timeline = queries.getApplicationTimeline(applicationId);
    assert.ok(timeline);
    assert.deepEqual(
      timeline.map((event) => [event.sequenceNumber, event.eventType, event.toState]),
      [
        [1, "application_created", "discovered"],
        [2, "state_transition", "normalized"],
      ],
    );
    assert.equal(queries.getApplicationTimeline("missing-application"), null);
  });

  test("computes dashboard metrics from applications, reviews, settings, and events", () => {
    const database = openMemoryDatabase();
    const queries = new ReadModelQueries(database);
    const reviews = new ReviewRepository(database);
    const applications = new ApplicationRepository(database);
    const { jobId } = createJob(database, "a");
    const applicationId = applications.create({
      jobId,
      automationMode: "assisted",
      now: "2026-01-01T00:00:00.000Z",
    });
    reviews.create({
      applicationId,
      reviewType: "unknown_requirement",
      summary: "Synthetic unresolved review item.",
      now: "2026-01-02T00:00:00.000Z",
    });

    const metrics = queries.getDashboardMetrics();
    assert.deepEqual(metrics.applicationStateCounts, [{ state: "discovered", count: 1 }]);
    assert.equal(metrics.openReviewItemCount, 1);
    assert.equal(metrics.automationPaused, true);
    assert.equal(metrics.recentEvents.length, 1);
    assert.equal(metrics.recentEvents[0]?.eventType, "application_created");
  });
});

describe("review repository", () => {
  test("requires exactly one review subject", () => {
    const database = openMemoryDatabase();
    const reviews = new ReviewRepository(database);
    assert.throws(
      () => reviews.create({ reviewType: "diagnostic", summary: "No subject." }),
      /exactly one subject/,
    );
    assert.throws(
      () =>
        reviews.create({
          applicationId: "app",
          eligibilityAssessmentId: "assessment",
          reviewType: "diagnostic",
          summary: "Two subjects.",
        }),
      /exactly one subject/,
    );
  });

  test("resolves an open item once and rejects a second resolution unchanged", () => {
    const database = openMemoryDatabase();
    const reviews = new ReviewRepository(database);
    const applications = new ApplicationRepository(database);
    const { jobId } = createJob(database, "a");
    const applicationId = applications.create({
      jobId,
      automationMode: "assisted",
      now: "2026-01-01T00:00:00.000Z",
    });
    const reviewItemId = reviews.create({
      applicationId,
      reviewType: "unknown_requirement",
      summary: "Synthetic review item.",
      now: "2026-01-02T00:00:00.000Z",
    });

    const resolved = reviews.resolve({
      reviewItemId,
      outcome: "resolved",
      reason: "Synthetic verification completed.",
      now: "2026-01-03T00:00:00.000Z",
    });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolutionReason, "Synthetic verification completed.");

    assert.throws(
      () =>
        reviews.resolve({
          reviewItemId,
          outcome: "dismissed",
          reason: "Second attempt.",
        }),
      /already resolved/,
    );
    const after = reviews.list({ status: "resolved" });
    assert.equal(after.length, 1);
    assert.equal(after[0]?.resolutionReason, "Synthetic verification completed.");
    assert.equal(reviews.list({ status: "open" }).length, 0);
  });

  test("rejects resolving a missing item and blank reasons", () => {
    const database = openMemoryDatabase();
    const reviews = new ReviewRepository(database);
    assert.throws(
      () => reviews.resolve({ reviewItemId: "missing", outcome: "resolved", reason: "x" }),
      /was not found/,
    );
    assert.throws(
      () => reviews.resolve({ reviewItemId: "missing", outcome: "resolved", reason: "  " }),
      /reason is required/,
    );
  });
});

describe("settings repository", () => {
  test("reads seeded defaults and applies partial updates", () => {
    const database = openMemoryDatabase();
    const settings = new SettingsRepository(database);
    const initial = settings.get();
    assert.equal(initial.automationPaused, true);
    assert.equal(initial.defaultMode, "assisted");
    assert.equal(initial.dailyApplicationLimit, 10);

    const updated = settings.update({
      dailyApplicationLimit: 3,
      now: "2026-02-01T00:00:00.000Z",
    });
    assert.equal(updated.dailyApplicationLimit, 3);
    assert.equal(updated.defaultMode, "assisted");
    assert.equal(updated.updatedAt, "2026-02-01T00:00:00.000Z");

    const modeOnly = settings.update({ defaultMode: "manual" });
    assert.equal(modeOnly.defaultMode, "manual");
    assert.equal(modeOnly.dailyApplicationLimit, 3);
  });

  test("rejects empty and invalid updates", () => {
    const database = openMemoryDatabase();
    const settings = new SettingsRepository(database);
    assert.throws(() => settings.update({}), /at least one field/);
    assert.throws(
      () => settings.update({ dailyApplicationLimit: -1 }),
      /non-negative integer/,
    );
    assert.throws(
      () => settings.update({ dailyApplicationLimit: 1.5 }),
      /non-negative integer/,
    );
    assert.equal(settings.get().dailyApplicationLimit, 10);
  });

  test("pauses and resumes automation", () => {
    const database = openMemoryDatabase();
    const settings = new SettingsRepository(database);
    assert.equal(settings.setPaused({ paused: false }).automationPaused, false);
    assert.equal(settings.setPaused({ paused: true }).automationPaused, true);
  });
});
