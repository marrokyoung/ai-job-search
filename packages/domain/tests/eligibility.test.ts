import { describe, expect, test } from "bun:test";
import { evaluateEligibility } from "../src/eligibility.ts";

const span = [{ start: 0, end: 20, quote: "Synthetic requirement" }] as const;

function extraction(
  requirements: Parameters<typeof evaluateEligibility>[0]["requirements"],
  overrides: Partial<Parameters<typeof evaluateEligibility>[0]> = {},
): Parameters<typeof evaluateEligibility>[0] {
  return {
    status: "complete",
    coverageConfidence: 0.95,
    sourceTextHash: "synthetic-posting-hash",
    requirements,
    ...overrides,
  };
}

describe("lenient eligibility policy", () => {
  test("keeps an automotive engineering job eligible despite major experience gaps", () => {
    const decision = evaluateEligibility(extraction([
      {
        requirement: "Five to seven years of automotive industry experience",
        category: "experience_years",
        fulfillment: "missing",
        mandatory: true,
        classificationConfidence: 0.98,
        sourceSpans: span,
      },
      {
        requirement: "Prior automotive industry experience",
        category: "industry_experience",
        fulfillment: "missing",
        mandatory: true,
        classificationConfidence: 0.98,
        sourceSpans: span,
      },
      {
        requirement: "Relevant engineering training",
        category: "education",
        fulfillment: "satisfied",
        mandatory: true,
        classificationConfidence: 0.98,
        sourceSpans: span,
        evidenceIds: ["synthetic-training-record"],
      },
    ]));

    expect(decision.status).toBe("eligible");
    expect(decision.softGaps).toHaveLength(2);
    expect(decision.hardStops).toHaveLength(0);
  });

  test("keeps a missing preferred technology as a soft gap", () => {
    const decision = evaluateEligibility(extraction([
      {
        requirement: "Experience with a preferred simulation tool",
        category: "skill",
        fulfillment: "missing",
        mandatory: false,
        classificationConfidence: 0.98,
        sourceSpans: span,
      },
    ]));

    expect(decision.status).toBe("eligible");
    expect(decision.softGaps[0]?.severity).toBe("soft_gap");
  });

  test("blocks an explicitly absent mandatory professional license", () => {
    const decision = evaluateEligibility(extraction([
      {
        requirement: "Active professional license required by law",
        category: "license",
        fulfillment: "missing",
        mandatory: true,
        classificationConfidence: 0.98,
        sourceSpans: span,
      },
    ]));

    expect(decision.status).toBe("blocked");
    expect(decision.hardStops).toHaveLength(1);
  });

  test("reviews an unknown mandatory license instead of guessing", () => {
    const decision = evaluateEligibility(extraction([
      {
        requirement: "Active professional license",
        category: "license",
        fulfillment: "unknown",
        mandatory: true,
        classificationConfidence: 0.98,
        sourceSpans: span,
      },
    ]));

    expect(decision.status).toBe("needs_review");
    expect(decision.unknowns).toHaveLength(1);
  });

  test("hard stops take precedence over unknown requirements", () => {
    const decision = evaluateEligibility(extraction([
      {
        requirement: "Work authorization",
        category: "work_authorization",
        fulfillment: "missing",
        mandatory: true,
        classificationConfidence: 0.98,
        sourceSpans: span,
      },
      {
        requirement: "Physical requirement",
        category: "physical_or_safety",
        fulfillment: "unknown",
        mandatory: true,
        classificationConfidence: 0.98,
        sourceSpans: span,
      },
    ]));

    expect(decision.status).toBe("blocked");
    expect(decision.hardStops).toHaveLength(1);
    expect(decision.unknowns).toHaveLength(1);
  });

  test("reviews failed or empty extraction instead of assuming eligibility", () => {
    const decision = evaluateEligibility(
      extraction([], { status: "failed", coverageConfidence: 0 }),
    );

    expect(decision.status).toBe("needs_review");
    expect(decision.extractionIssues.length).toBeGreaterThanOrEqual(2);
  });

  test("reviews a low-confidence category that could conceal a legal credential", () => {
    const decision = evaluateEligibility(extraction([
      {
        requirement: "Possibly regulated certification",
        category: "skill",
        fulfillment: "missing",
        mandatory: true,
        classificationConfidence: 0.45,
        sourceSpans: span,
      },
    ]));

    expect(decision.status).toBe("needs_review");
    expect(decision.unknowns).toHaveLength(1);
  });

  test("reviews contradictory classifications of the same requirement", () => {
    const decision = evaluateEligibility(extraction([
      {
        requirement: "Professional certification",
        category: "skill",
        fulfillment: "missing",
        mandatory: false,
        classificationConfidence: 0.95,
        sourceSpans: span,
      },
      {
        requirement: "Professional certification",
        category: "license",
        fulfillment: "missing",
        mandatory: true,
        classificationConfidence: 0.95,
        sourceSpans: span,
      },
    ]));

    expect(decision.status).toBe("needs_review");
    expect(decision.extractionIssues).toHaveLength(1);
  });

  test("reviews a requirement without source spans", () => {
    const decision = evaluateEligibility(extraction([
      {
        requirement: "Untraceable requirement",
        category: "skill",
        fulfillment: "missing",
        mandatory: false,
        classificationConfidence: 0.99,
        sourceSpans: [],
      },
    ]));

    expect(decision.status).toBe("needs_review");
  });

  test("reviews invalid confidence and missing extraction provenance", () => {
    const decision = evaluateEligibility(
      extraction(
        [
          {
            requirement: "Synthetic requirement",
            category: "skill",
            fulfillment: "missing",
            mandatory: false,
            classificationConfidence: Number.NaN,
            sourceSpans: span,
          },
        ],
        { coverageConfidence: Number.NaN, sourceTextHash: "" },
      ),
    );

    expect(decision.status).toBe("needs_review");
    expect(decision.extractionIssues).toHaveLength(2);
  });
});
