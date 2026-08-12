import type {
  EligibilityDecision,
  ProposedRequirement,
  RequirementExtraction,
  RequirementAssessment,
  RequirementCategory,
  RequirementSeverity,
} from "./types.ts";

const MIN_EXTRACTION_CONFIDENCE = 0.8;

function meetsConfidenceThreshold(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= MIN_EXTRACTION_CONFIDENCE &&
    value <= 1
  );
}

function hasValidSourceSpan(requirement: ProposedRequirement): boolean {
  return requirement.sourceSpans.some(
    (span) =>
      Number.isInteger(span.start) &&
      Number.isInteger(span.end) &&
      span.start >= 0 &&
      span.end > span.start &&
      Boolean(span.quote.trim()),
  );
}

const ALWAYS_SOFT_CATEGORIES = new Set<RequirementCategory>([
  "experience_years",
  "industry_experience",
  "skill",
  "education",
]);

const REGULATED_HARD_STOP_CATEGORIES = new Set<RequirementCategory>([
  "license",
  "work_authorization",
  "clearance",
  "physical_or_safety",
  "user_preference",
]);

function severityFor(requirement: ProposedRequirement): RequirementSeverity {
  if (
    !meetsConfidenceThreshold(requirement.classificationConfidence) ||
    !hasValidSourceSpan(requirement)
  ) {
    return "unknown";
  }

  if (requirement.fulfillment === "satisfied") {
    return "satisfied";
  }

  if (requirement.fulfillment === "unknown") {
    return requirement.mandatory ? "unknown" : "soft_gap";
  }

  if (ALWAYS_SOFT_CATEGORIES.has(requirement.category)) {
    return "soft_gap";
  }

  if (
    requirement.mandatory &&
    REGULATED_HARD_STOP_CATEGORIES.has(requirement.category)
  ) {
    return "hard_stop";
  }

  return requirement.mandatory ? "unknown" : "soft_gap";
}

function defaultExplanation(
  requirement: ProposedRequirement,
  severity: RequirementSeverity,
): string {
  switch (severity) {
    case "satisfied":
      return "The candidate has verified evidence satisfying this requirement.";
    case "soft_gap":
      return "This gap may affect ranking and tailoring, but it does not prevent an application.";
    case "hard_stop":
      return "This mandatory regulated or user-defined requirement is explicitly unsatisfied.";
    case "unknown":
      return "A mandatory fact is unknown and must be reviewed rather than guessed.";
  }
}

export function assessRequirement(
  requirement: ProposedRequirement,
): RequirementAssessment {
  const severity = severityFor(requirement);

  return {
    requirement: requirement.requirement,
    category: requirement.category,
    severity,
    mandatory: requirement.mandatory,
    classificationConfidence: requirement.classificationConfidence,
    sourceSpans: requirement.sourceSpans,
    evidenceIds: requirement.evidenceIds ?? [],
    explanation:
      requirement.explanation ?? defaultExplanation(requirement, severity),
  };
}

function extractionIssue(requirement: string, explanation: string): RequirementAssessment {
  return {
    requirement,
    category: "other",
    severity: "unknown",
    mandatory: true,
    classificationConfidence: 0,
    sourceSpans: [],
    evidenceIds: [],
    explanation,
  };
}

function findContradictions(
  requirements: readonly ProposedRequirement[],
): RequirementAssessment[] {
  const byText = new Map<string, ProposedRequirement>();
  const issues: RequirementAssessment[] = [];

  for (const requirement of requirements) {
    const key = requirement.requirement.trim().toLocaleLowerCase();
    const previous = byText.get(key);
    if (
      previous &&
      (previous.category !== requirement.category ||
        previous.mandatory !== requirement.mandatory ||
        previous.fulfillment !== requirement.fulfillment)
    ) {
      issues.push(
        extractionIssue(
          requirement.requirement,
          "The same requirement received contradictory classifications and must be reviewed.",
        ),
      );
    } else if (!previous) {
      byText.set(key, requirement);
    }
  }

  return issues;
}

export function evaluateEligibility(
  extraction: RequirementExtraction,
): EligibilityDecision {
  const extractionIssues: RequirementAssessment[] = [];

  if (extraction.status !== "complete") {
    extractionIssues.push(
      extractionIssue(
        "Requirement extraction completeness",
        `Requirement extraction is ${extraction.status}; eligibility cannot be assumed.`,
      ),
    );
  }
  if (!meetsConfidenceThreshold(extraction.coverageConfidence)) {
    extractionIssues.push(
      extractionIssue(
        "Requirement extraction coverage",
        "Requirement extraction coverage is below the safety threshold.",
      ),
    );
  }
  if (extraction.requirements.length === 0) {
    extractionIssues.push(
      extractionIssue(
        "Requirement extraction result",
        "No requirements were extracted, which is treated as an extraction failure rather than eligibility.",
      ),
    );
  }
  if (!extraction.sourceTextHash.trim()) {
    extractionIssues.push(
      extractionIssue(
        "Requirement extraction provenance",
        "Requirement extraction is missing its posting source hash.",
      ),
    );
  }
  extractionIssues.push(...findContradictions(extraction.requirements));

  const assessments = [
    ...extraction.requirements.map(assessRequirement),
    ...extractionIssues,
  ];
  const hardStops = assessments.filter(
    (assessment) => assessment.severity === "hard_stop",
  );
  const unknowns = assessments.filter(
    (assessment) => assessment.severity === "unknown",
  );
  const softGaps = assessments.filter(
    (assessment) => assessment.severity === "soft_gap",
  );

  const status =
    extractionIssues.length > 0
      ? "needs_review"
      : hardStops.length > 0
      ? "blocked"
      : unknowns.length > 0
        ? "needs_review"
        : "eligible";

  return {
    status,
    assessments,
    softGaps,
    hardStops,
    unknowns,
    extractionIssues,
  };
}
