import { describe, expect, test } from "bun:test";
import {
  InvalidApplicationTransitionError,
  UnauthorizedApplicationTransitionError,
  allowedTransitionsFrom,
  assertAuthorizedTransition,
  assertOutcomeCorrection,
  assertTransition,
  canTransition,
} from "../src/state-machine.ts";

describe("application state machine", () => {
  test("allows the normal path to submission", () => {
    const path = [
      ["discovered", "normalized"],
      ["normalized", "eligible"],
      ["eligible", "shortlisted"],
      ["shortlisted", "preparing"],
      ["preparing", "ready_to_submit"],
      ["ready_to_submit", "awaiting_approval"],
      ["awaiting_approval", "submitting"],
      ["submitting", "submitted"],
    ] as const;

    for (const [from, to] of path) {
      expect(canTransition(from, to)).toBe(true);
      expect(() => assertTransition(from, to)).not.toThrow();
    }
  });

  test("rejects skipping directly from discovery to submission", () => {
    expect(() => assertTransition("discovered", "submitted")).toThrow(
      InvalidApplicationTransitionError,
    );
  });

  test("permits repeated interview stages", () => {
    expect(canTransition("interview", "interview")).toBe(true);
  });

  test("does not allow a terminal rejection to restart automatically", () => {
    expect(allowedTransitionsFrom("rejected")).toEqual([]);
  });

  test("requires reevaluation before a reviewed job can be shortlisted", () => {
    expect(canTransition("needs_review", "shortlisted")).toBe(false);
    expect(() =>
      assertAuthorizedTransition({
        from: "needs_review",
        to: "eligible",
        authorization: {
          automationMode: "assisted",
          actor: "system",
          verification: { result: "not_run" },
          sourceSubmissionAllowed: false,
          globalAutomationPaused: false,
        },
      }),
    ).toThrow(UnauthorizedApplicationTransitionError);

    expect(() =>
      assertAuthorizedTransition({
        from: "needs_review",
        to: "eligible",
        authorization: {
          automationMode: "assisted",
          actor: "system",
          verification: { result: "not_run" },
          sourceSubmissionAllowed: false,
          globalAutomationPaused: false,
          eligibilityAssessmentReference: "eligibility-event-2",
        },
      }),
    ).toThrow(UnauthorizedApplicationTransitionError);

    expect(() =>
      assertAuthorizedTransition({
        from: "needs_review",
        to: "eligible",
        authorization: {
          automationMode: "assisted",
          actor: "system",
          verification: { result: "not_run" },
          sourceSubmissionAllowed: false,
          globalAutomationPaused: false,
          eligibilityAssessmentReference: "eligibility-event-2",
          resolvedCandidateFactReferences: ["candidate-fact-2"],
        },
      }),
    ).not.toThrow();
  });

  test("requires evidence for every initial eligibility decision", () => {
    expect(() =>
      assertAuthorizedTransition({
        from: "normalized",
        to: "eligible",
        authorization: {
          automationMode: "assisted",
          actor: "system",
          verification: { result: "not_run" },
          sourceSubmissionAllowed: false,
          globalAutomationPaused: true,
        },
      }),
    ).toThrow(UnauthorizedApplicationTransitionError);

    expect(() =>
      assertAuthorizedTransition({
        from: "normalized",
        to: "eligible",
        authorization: {
          automationMode: "assisted",
          actor: "system",
          verification: { result: "not_run" },
          sourceSubmissionAllowed: false,
          globalAutomationPaused: true,
          eligibilityAssessmentReference: "persisted-assessment-1",
        },
      }),
    ).not.toThrow();
  });

  test("requires recorded human approval for assisted submission", () => {
    expect(() =>
      assertAuthorizedTransition({
        from: "awaiting_approval",
        to: "submitting",
        authorization: {
          automationMode: "assisted",
          actor: "system",
          approval: {
            kind: "policy",
            reference: "policy-event-1",
            approvedBy: "system",
          },
          verification: {
            result: "passed",
            reference: "verification-event-1",
          },
          sourceSubmissionAllowed: true,
          globalAutomationPaused: false,
          idempotencyKey: "application-1-attempt-1",
        },
      }),
    ).toThrow(UnauthorizedApplicationTransitionError);

    expect(() =>
      assertAuthorizedTransition({
        from: "awaiting_approval",
        to: "submitting",
        authorization: {
          automationMode: "assisted",
          actor: "system",
          approval: {
            kind: "human",
            reference: "approval-event-1",
            approvedBy: "user",
          },
          verification: {
            result: "passed",
            reference: "verification-event-1",
          },
          sourceSubmissionAllowed: true,
          globalAutomationPaused: false,
          idempotencyKey: "application-1-attempt-1",
        },
      }),
    ).not.toThrow();
  });

  test("requires policy approval and all safety context for autonomous submission", () => {
    const validCommand = {
      from: "awaiting_approval",
      to: "submitting",
      authorization: {
        automationMode: "autonomous",
        actor: "system",
        approval: {
          kind: "policy",
          reference: "policy-decision-1",
          approvedBy: "system",
        },
        verification: {
          result: "passed",
          reference: "verification-event-2",
        },
        sourceSubmissionAllowed: true,
        globalAutomationPaused: false,
        idempotencyKey: "application-2-attempt-1",
      },
    } as const;

    expect(() => assertAuthorizedTransition(validCommand)).not.toThrow();
    expect(() =>
      assertAuthorizedTransition({
        ...validCommand,
        authorization: {
          ...validCommand.authorization,
          globalAutomationPaused: true,
        },
      }),
    ).toThrow(UnauthorizedApplicationTransitionError);
  });

  test("supports user-authorized compensating outcome corrections", () => {
    expect(() =>
      assertOutcomeCorrection({
        from: "rejected",
        to: "interview",
        actor: "user",
        supersededEventId: "email-classification-event-1",
        reason: "The email was an interview invitation, not a rejection.",
      }),
    ).not.toThrow();

    expect(() =>
      assertOutcomeCorrection({
        from: "rejected",
        to: "interview",
        actor: "agent",
        supersededEventId: "email-classification-event-1",
        reason: "Automated reclassification",
      }),
    ).toThrow(UnauthorizedApplicationTransitionError);
  });
});
