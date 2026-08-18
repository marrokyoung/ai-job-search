import { createHash } from "node:crypto";
import type { ApplicationTransitionCommand } from "@us-job-agent/domain";
import type Database from "better-sqlite3";
import { getDatabaseConnection } from "./database-internal.ts";
import type { JobAgentDatabase } from "./database.ts";
import { ApplicationRepository, JobRepository } from "./repositories.ts";
import { ReviewRepository } from "./reviews.ts";

type SeededAssessmentInput = {
  suffix: string;
  snapshotId: string;
  status: "eligible" | "blocked" | "needs_review";
  createdAt: string;
  requirements: Array<{
    text: string;
    category: string;
    fulfillment: "satisfied" | "missing" | "unknown";
    mandatory: boolean;
    severity: "satisfied" | "soft_gap" | "hard_stop" | "unknown";
    explanation: string;
  }>;
};

function insertSeedAssessment(
  sqlite: Database.Database,
  input: SeededAssessmentInput,
): string {
  const extractionId = `seed-extraction-${input.suffix}`;
  const assessmentId = `seed-assessment-${input.suffix}`;
  sqlite
    .prepare(
      `INSERT INTO requirement_extractions (
         id, job_snapshot_id, status, coverage_confidence, source_text_hash,
         extractor_name, extractor_version, created_at
       ) VALUES (?, ?, 'complete', 1.0, ?, 'synthetic-seed', 'v1', ?)`,
    )
    .run(extractionId, input.snapshotId, `seed-source-${input.suffix}`, input.createdAt);
  sqlite
    .prepare(
      `INSERT INTO eligibility_assessments (
         id, extraction_id, status, evaluator_version, created_at
       ) VALUES (?, ?, ?, 'seed-v1', ?)`,
    )
    .run(assessmentId, extractionId, input.status, input.createdAt);
  input.requirements.forEach((requirement, ordinal) => {
    const requirementId = `seed-requirement-${input.suffix}-${ordinal}`;
    sqlite
      .prepare(
        `INSERT INTO requirements (
           id, extraction_id, requirement_ordinal, requirement_text, category,
           fulfillment, mandatory, classification_confidence, explanation
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0.9, ?)`,
      )
      .run(
        requirementId,
        extractionId,
        ordinal,
        requirement.text,
        requirement.category,
        requirement.fulfillment,
        requirement.mandatory ? 1 : 0,
        requirement.explanation,
      );
    sqlite
      .prepare(
        `INSERT INTO requirement_assessments (
           id, eligibility_assessment_id, requirement_id, extraction_id, severity, explanation
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `seed-ra-${input.suffix}-${ordinal}`,
        assessmentId,
        requirementId,
        extractionId,
        requirement.severity,
        requirement.explanation,
      );
  });
  return assessmentId;
}

function systemAuthorization(
  automationMode: "manual" | "assisted" | "autonomous",
  eligibilityAssessmentReference?: string,
) {
  return {
    automationMode,
    actor: "system" as const,
    verification: { result: "not_run" as const },
    sourceSubmissionAllowed: false,
    globalAutomationPaused: true,
    ...(eligibilityAssessmentReference === undefined
      ? {}
      : { eligibilityAssessmentReference }),
  };
}

/**
 * Seeds a deterministic, entirely synthetic development workspace: four jobs
 * covering every eligibility outcome (eligible with soft gaps, blocked,
 * needs-review, and not yet assessed), applications progressed through real
 * validated transitions, and one open review item.
 *
 * Convergent rather than all-or-nothing: every component is checked and
 * created individually, so re-running is idempotent AND a database seeded by
 * an older, smaller version of this fixture (e.g. the Phase 1C single-job
 * seed) is topped up to the full workspace instead of being left as-is.
 * Application transitions are applied only from their exact expected
 * predecessor state, so records a developer has moved along are not touched.
 */
export function seedSyntheticData(database: JobAgentDatabase): {
  jobId: string;
  applicationId: string;
} {
  const sqlite = getDatabaseConnection(database);
  const jobs = new JobRepository(database);
  const applications = new ApplicationRepository(database);
  const reviews = new ReviewRepository(database);

  // Everything below runs in one transaction (repository transactions nest as
  // savepoints), so a failed seed leaves no partial synthetic workspace.
  return sqlite.transaction(() => {
    const ensureJob = (input: {
      sourceJobId: string;
      organizationName: string;
      title: string;
      locationText: string;
      workplaceType: "remote" | "hybrid" | "onsite" | "unknown";
      descriptionText: string;
      now: string;
    }): { jobId: string; snapshotId: string } => {
      const existing = sqlite
        .prepare(
          `SELECT j.id AS job_id,
                  (SELECT id FROM job_snapshots WHERE job_id = j.id
                   ORDER BY captured_at DESC, id DESC LIMIT 1) AS snapshot_id
           FROM jobs j
           JOIN job_sources s ON s.id = j.source_id
           WHERE s.source_key = 'synthetic' AND j.source_job_id = ?`,
        )
        .get(input.sourceJobId) as { job_id: string; snapshot_id: string } | undefined;
      if (existing) return { jobId: existing.job_id, snapshotId: existing.snapshot_id };
      return jobs.createWithSnapshot({
        sourceKey: "synthetic",
        sourceDisplayName: "Synthetic Development Source",
        sourceJobId: input.sourceJobId,
        canonicalUrl: `https://example.invalid/jobs/${input.sourceJobId}`,
        organizationName: input.organizationName,
        title: input.title,
        locationText: input.locationText,
        workplaceType: input.workplaceType,
        employmentType: "full-time",
        descriptionText: input.descriptionText,
        contentHash: createHash("sha256").update(input.descriptionText).digest("hex"),
        now: input.now,
      });
    };

    const ensureAssessment = (input: SeededAssessmentInput): string => {
      const assessmentId = `seed-assessment-${input.suffix}`;
      const existing = sqlite
        .prepare("SELECT id FROM eligibility_assessments WHERE id = ?")
        .get(assessmentId) as { id: string } | undefined;
      return existing ? existing.id : insertSeedAssessment(sqlite, input);
    };

    const ensureApplication = (
      jobId: string,
      automationMode: "manual" | "assisted" | "autonomous",
      now: string,
    ): string => {
      const existing = sqlite
        .prepare(
          "SELECT id FROM applications WHERE job_id = ? ORDER BY attempt_number LIMIT 1",
        )
        .get(jobId) as { id: string } | undefined;
      return existing ? existing.id : applications.create({ jobId, automationMode, now });
    };

    /** Applies each step only when the application sits in its exact `from` state. */
    const advance = (
      applicationId: string,
      steps: Array<{
        command: ApplicationTransitionCommand;
        reason: string;
        now: string;
      }>,
    ): void => {
      for (const step of steps) {
        const current = sqlite
          .prepare("SELECT current_state FROM applications WHERE id = ?")
          .get(applicationId) as { current_state: string } | undefined;
        if (current?.current_state !== step.command.from) continue;
        applications.transition({
          applicationId,
          command: step.command,
          reason: step.reason,
          now: step.now,
        });
      }
    };

    // Job A: eligible despite experience soft gaps — the broad-application
    // leniency scenario the eligibility policy is built around.
    const jobA = ensureJob({
      sourceJobId: "synthetic-automotive-001",
      organizationName: "Example Mobility Labs",
      title: "Automotive Systems Engineer",
      locationText: "Detroit, MI",
      workplaceType: "hybrid",
      descriptionText:
        "Synthetic automotive systems role. Five years requested; training and transferable projects welcomed.",
      now: "2026-01-01T08:00:00.000Z",
    });
    const assessmentA = ensureAssessment({
      suffix: "a",
      snapshotId: jobA.snapshotId,
      status: "eligible",
      createdAt: "2026-01-02T08:00:00.000Z",
      requirements: [
        {
          text: "Five or more years of automotive systems experience.",
          category: "experience_years",
          fulfillment: "missing",
          mandatory: true,
          severity: "soft_gap",
          explanation: "Experience-year gaps are soft by policy and never block.",
        },
        {
          text: "Prior automotive industry employment.",
          category: "industry_experience",
          fulfillment: "missing",
          mandatory: false,
          severity: "soft_gap",
          explanation: "Industry-experience gaps are soft by policy and never block.",
        },
        {
          text: "Systems engineering fundamentals.",
          category: "skill",
          fulfillment: "satisfied",
          mandatory: true,
          severity: "satisfied",
          explanation: "Covered by the synthetic candidate's engineering background.",
        },
      ],
    });
    const applicationA = ensureApplication(
      jobA.jobId,
      "assisted",
      "2026-01-01T09:00:00.000Z",
    );
    advance(applicationA, [
      {
        command: {
          from: "discovered",
          to: "normalized",
          authorization: systemAuthorization("assisted"),
        },
        reason: "Synthetic posting normalized.",
        now: "2026-01-02T09:00:00.000Z",
      },
      {
        command: {
          from: "normalized",
          to: "eligible",
          authorization: systemAuthorization("assisted", assessmentA),
        },
        reason: "Eligible: experience gaps are soft gaps by policy.",
        now: "2026-01-02T10:00:00.000Z",
      },
      {
        command: {
          from: "eligible",
          to: "shortlisted",
          authorization: { ...systemAuthorization("assisted"), actor: "user" },
        },
        reason: "Shortlisted by the synthetic user for tailoring.",
        now: "2026-01-03T09:00:00.000Z",
      },
    ]);

    // Job B: blocked — the candidate fact store explicitly records the
    // mandatory license as absent, the one legitimate hard stop.
    const jobB = ensureJob({
      sourceJobId: "synthetic-driver-002",
      organizationName: "Example Freight Lines",
      title: "Commercial Delivery Driver",
      locationText: "Columbus, OH",
      workplaceType: "onsite",
      descriptionText:
        "Synthetic driving role requiring a commercial driver's license (CDL-A) held today.",
      now: "2026-01-04T08:00:00.000Z",
    });
    const assessmentB = ensureAssessment({
      suffix: "b",
      snapshotId: jobB.snapshotId,
      status: "blocked",
      createdAt: "2026-01-05T08:00:00.000Z",
      requirements: [
        {
          text: "Valid commercial driver's license (CDL-A).",
          category: "license",
          fulfillment: "missing",
          mandatory: true,
          severity: "hard_stop",
          explanation: "The synthetic candidate fact store records this license as absent.",
        },
        {
          text: "Three years of route driving experience.",
          category: "experience_years",
          fulfillment: "missing",
          mandatory: false,
          severity: "soft_gap",
          explanation: "Experience-year gaps are soft by policy and never block.",
        },
      ],
    });
    const applicationB = ensureApplication(
      jobB.jobId,
      "manual",
      "2026-01-04T09:00:00.000Z",
    );
    advance(applicationB, [
      {
        command: {
          from: "discovered",
          to: "normalized",
          authorization: systemAuthorization("manual"),
        },
        reason: "Synthetic posting normalized.",
        now: "2026-01-05T09:00:00.000Z",
      },
      {
        command: {
          from: "normalized",
          to: "hard_stopped",
          authorization: systemAuthorization("manual", assessmentB),
        },
        reason: "Blocked: the mandatory CDL-A license is recorded as absent.",
        now: "2026-01-05T10:00:00.000Z",
      },
    ]);

    // Job C: needs review — an unknown mandatory fact creates a review item
    // instead of a guessed answer.
    const jobC = ensureJob({
      sourceJobId: "synthetic-technician-003",
      organizationName: "Example Robotics Group",
      title: "Field Service Technician",
      locationText: "Toledo, OH",
      workplaceType: "onsite",
      descriptionText:
        "Synthetic field service role; a state electrical license may be required depending on site.",
      now: "2026-01-06T08:00:00.000Z",
    });
    const assessmentC = ensureAssessment({
      suffix: "c",
      snapshotId: jobC.snapshotId,
      status: "needs_review",
      createdAt: "2026-01-07T08:00:00.000Z",
      requirements: [
        {
          text: "State electrical license may be required.",
          category: "license",
          fulfillment: "unknown",
          mandatory: true,
          severity: "unknown",
          explanation:
            "The candidate fact store has no entry for this license; review instead of guessing.",
        },
      ],
    });
    const applicationC = ensureApplication(
      jobC.jobId,
      "assisted",
      "2026-01-06T09:00:00.000Z",
    );
    advance(applicationC, [
      {
        command: {
          from: "discovered",
          to: "normalized",
          authorization: systemAuthorization("assisted"),
        },
        reason: "Synthetic posting normalized.",
        now: "2026-01-07T09:00:00.000Z",
      },
      {
        command: {
          from: "normalized",
          to: "needs_review",
          authorization: systemAuthorization("assisted", assessmentC),
        },
        reason: "Needs review: license status is unknown for this synthetic candidate.",
        now: "2026-01-07T10:00:00.000Z",
      },
    ]);
    const existingReview = sqlite
      .prepare(
        `SELECT id FROM review_items
         WHERE application_id = ? AND review_type = 'unknown_requirement'
         LIMIT 1`,
      )
      .get(applicationC) as { id: string } | undefined;
    if (!existingReview) {
      reviews.create({
        applicationId: applicationC,
        reviewType: "unknown_requirement",
        summary:
          "Confirm whether the synthetic candidate holds a state electrical license; the posting may require one.",
        now: "2026-01-07T10:30:00.000Z",
      });
    }

    // Job D: discovered but not yet assessed — the null-eligibility case.
    ensureJob({
      sourceJobId: "synthetic-manufacturing-004",
      organizationName: "Example Mobility Labs",
      title: "Manufacturing Process Engineer",
      locationText: "Detroit, MI",
      workplaceType: "hybrid",
      descriptionText:
        "Synthetic manufacturing role awaiting requirement extraction and eligibility assessment.",
      now: "2026-01-08T08:00:00.000Z",
    });

    return { jobId: jobA.jobId, applicationId: applicationA };
  })();
}
