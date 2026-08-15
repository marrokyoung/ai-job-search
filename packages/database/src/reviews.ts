import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDatabaseConnection } from "./database-internal.ts";
import type { JobAgentDatabase } from "./database.ts";

export type ReviewItemStatus = "open" | "resolved" | "dismissed";

export type ReviewItemView = {
  reviewItemId: string;
  applicationId: string | null;
  eligibilityAssessmentId: string | null;
  reviewType: string;
  status: ReviewItemStatus;
  summary: string;
  resolutionReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type CreateReviewItemInput = {
  applicationId?: string;
  eligibilityAssessmentId?: string;
  reviewType: string;
  summary: string;
  now?: string;
};

export type ResolveReviewItemInput = {
  reviewItemId: string;
  outcome: "resolved" | "dismissed";
  reason: string;
  now?: string;
};

export class ReviewItemNotFoundError extends Error {
  constructor(reviewItemId: string) {
    super(`Review item ${reviewItemId} was not found.`);
    this.name = "ReviewItemNotFoundError";
  }
}

export class ReviewItemNotOpenError extends Error {
  constructor(reviewItemId: string, status: ReviewItemStatus) {
    super(`Review item ${reviewItemId} is already ${status}.`);
    this.name = "ReviewItemNotOpenError";
  }
}

type ReviewItemRow = {
  id: string;
  application_id: string | null;
  eligibility_assessment_id: string | null;
  review_type: string;
  status: ReviewItemStatus;
  summary: string;
  resolution_reason: string | null;
  created_at: string;
  resolved_at: string | null;
};

function toView(row: ReviewItemRow): ReviewItemView {
  return {
    reviewItemId: row.id,
    applicationId: row.application_id,
    eligibilityAssessmentId: row.eligibility_assessment_id,
    reviewType: row.review_type,
    status: row.status,
    summary: row.summary,
    resolutionReason: row.resolution_reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export class ReviewRepository {
  constructor(private readonly database: JobAgentDatabase) {}

  private get sqlite(): Database.Database {
    return getDatabaseConnection(this.database);
  }

  create(input: CreateReviewItemInput): string {
    const hasApplication = typeof input.applicationId === "string";
    const hasAssessment = typeof input.eligibilityAssessmentId === "string";
    if (hasApplication === hasAssessment) {
      throw new Error(
        "A review item must reference exactly one subject: an application or an eligibility assessment.",
      );
    }
    if (!input.reviewType.trim()) throw new Error("A review type is required.");
    if (!input.summary.trim()) throw new Error("A review summary is required.");
    const reviewItemId = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO review_items (
           id, application_id, eligibility_assessment_id, review_type, status,
           summary, created_at
         ) VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        reviewItemId,
        input.applicationId ?? null,
        input.eligibilityAssessmentId ?? null,
        input.reviewType,
        input.summary,
        input.now ?? new Date().toISOString(),
      );
    return reviewItemId;
  }

  resolve(input: ResolveReviewItemInput): ReviewItemView {
    if (!input.reason.trim()) throw new Error("A resolution reason is required.");
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare("SELECT status FROM review_items WHERE id = ?")
        .get(input.reviewItemId) as { status: ReviewItemStatus } | undefined;
      if (!row) throw new ReviewItemNotFoundError(input.reviewItemId);
      if (row.status !== "open") {
        throw new ReviewItemNotOpenError(input.reviewItemId, row.status);
      }
      this.sqlite
        .prepare(
          `UPDATE review_items
           SET status = ?, resolution_reason = ?, resolved_at = ?
           WHERE id = ?`,
        )
        .run(input.outcome, input.reason, now, input.reviewItemId);
      const updated = this.sqlite
        .prepare("SELECT * FROM review_items WHERE id = ?")
        .get(input.reviewItemId) as ReviewItemRow;
      return toView(updated);
    })();
  }

  list(filter?: { status?: ReviewItemStatus; limit?: number }): ReviewItemView[] {
    const status = filter?.status ?? null;
    const limit = filter?.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("List limit must be a positive integer.");
    }
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM review_items
         WHERE (:status IS NULL OR status = :status)
         ORDER BY created_at DESC, id
         LIMIT :limit`,
      )
      .all({ status, limit: Math.min(limit, 500) }) as ReviewItemRow[];
    return rows.map(toView);
  }
}
