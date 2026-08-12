export const requirementCategories = [
  "experience_years",
  "industry_experience",
  "skill",
  "education",
  "license",
  "work_authorization",
  "clearance",
  "physical_or_safety",
  "user_preference",
  "other",
] as const;

export type RequirementCategory = (typeof requirementCategories)[number];

export type RequirementFulfillment = "satisfied" | "missing" | "unknown";

export type RequirementSourceSpan = {
  start: number;
  end: number;
  quote: string;
};

export type RequirementExtractionStatus = "complete" | "partial" | "failed";

export type RequirementSeverity =
  | "satisfied"
  | "soft_gap"
  | "hard_stop"
  | "unknown";

export type ProposedRequirement = {
  requirement: string;
  category: RequirementCategory;
  fulfillment: RequirementFulfillment;
  mandatory: boolean;
  classificationConfidence: number;
  sourceSpans: readonly RequirementSourceSpan[];
  evidenceIds?: readonly string[];
  explanation?: string;
};

export type RequirementExtraction = {
  status: RequirementExtractionStatus;
  coverageConfidence: number;
  sourceTextHash: string;
  requirements: readonly ProposedRequirement[];
  warnings?: readonly string[];
};

export type RequirementAssessment = {
  requirement: string;
  category: RequirementCategory;
  severity: RequirementSeverity;
  mandatory: boolean;
  classificationConfidence: number;
  sourceSpans: readonly RequirementSourceSpan[];
  evidenceIds: readonly string[];
  explanation: string;
};

export type EligibilityStatus = "eligible" | "blocked" | "needs_review";

export type EligibilityDecision = {
  status: EligibilityStatus;
  assessments: readonly RequirementAssessment[];
  softGaps: readonly RequirementAssessment[];
  hardStops: readonly RequirementAssessment[];
  unknowns: readonly RequirementAssessment[];
  extractionIssues: readonly RequirementAssessment[];
};

export const applicationStates = [
  "discovered",
  "normalized",
  "eligible",
  "hard_stopped",
  "needs_review",
  "shortlisted",
  "skipped",
  "preparing",
  "verification_failed",
  "ready_to_submit",
  "awaiting_approval",
  "submitting",
  "submitted",
  "submission_failed",
  "confirmation_received",
  "assessment",
  "recruiter_contact",
  "interview",
  "rejected",
  "offer",
  "withdrawn",
  "closed_unknown",
] as const;

export type ApplicationState = (typeof applicationStates)[number];

export type AutomationMode = "manual" | "assisted" | "autonomous";

export type EventActor = "user" | "agent" | "system" | "external";
