import { createHash } from "node:crypto";
import { getDatabaseConnection } from "./database-internal.ts";
import type { JobAgentDatabase } from "./database.ts";
import { ApplicationRepository, JobRepository } from "./repositories.ts";

export function seedSyntheticData(database: JobAgentDatabase): {
  jobId: string;
  applicationId: string;
} {
  const existing = getDatabaseConnection(database)
    .prepare(
      `SELECT j.id AS job_id, a.id AS application_id
       FROM jobs j
       JOIN job_sources s ON s.id = j.source_id
       LEFT JOIN applications a ON a.job_id = j.id
       WHERE s.source_key = 'synthetic' AND j.source_job_id = 'synthetic-automotive-001'
       ORDER BY a.attempt_number
       LIMIT 1`,
    )
    .get() as { job_id: string; application_id: string | null } | undefined;
  if (existing?.application_id) {
    return { jobId: existing.job_id, applicationId: existing.application_id };
  }

  const description =
    "Synthetic automotive systems role. Five years requested; training and transferable projects welcomed.";
  const jobs = new JobRepository(database);
  const applications = new ApplicationRepository(database);
  const jobId = existing?.job_id ?? jobs.createWithSnapshot({
    sourceKey: "synthetic",
    sourceDisplayName: "Synthetic Development Source",
    sourceJobId: "synthetic-automotive-001",
    canonicalUrl: "https://example.invalid/jobs/synthetic-automotive-001",
    organizationName: "Example Mobility Labs",
    title: "Automotive Systems Engineer",
    locationText: "Detroit, MI",
    workplaceType: "hybrid",
    employmentType: "full-time",
    descriptionText: description,
    contentHash: createHash("sha256").update(description).digest("hex"),
    now: "2026-01-01T00:00:00.000Z",
  }).jobId;
  const applicationId = applications.create({
    jobId,
    automationMode: "assisted",
    now: "2026-01-01T00:00:00.000Z",
  });
  return { jobId, applicationId };
}
