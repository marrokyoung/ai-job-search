import type {
  ApplicationState,
  AutomationMode,
  EventActor,
} from "./types.ts";

const transitions: Readonly<Record<ApplicationState, readonly ApplicationState[]>> = {
  discovered: ["normalized"],
  normalized: ["eligible", "hard_stopped", "needs_review"],
  eligible: ["shortlisted", "skipped"],
  hard_stopped: ["needs_review", "skipped"],
  needs_review: ["eligible", "hard_stopped", "skipped"],
  shortlisted: ["preparing", "skipped"],
  skipped: [],
  preparing: ["verification_failed", "ready_to_submit", "skipped"],
  verification_failed: ["preparing", "needs_review", "skipped"],
  ready_to_submit: ["awaiting_approval", "skipped"],
  awaiting_approval: ["submitting", "skipped"],
  submitting: ["submitted", "submission_failed"],
  submitted: [
    "confirmation_received",
    "assessment",
    "recruiter_contact",
    "interview",
    "rejected",
    "offer",
    "withdrawn",
    "closed_unknown",
  ],
  submission_failed: ["submitting", "needs_review", "skipped"],
  confirmation_received: [
    "assessment",
    "recruiter_contact",
    "interview",
    "rejected",
    "offer",
    "withdrawn",
    "closed_unknown",
  ],
  assessment: [
    "recruiter_contact",
    "interview",
    "rejected",
    "offer",
    "withdrawn",
    "closed_unknown",
  ],
  recruiter_contact: [
    "assessment",
    "interview",
    "rejected",
    "offer",
    "withdrawn",
    "closed_unknown",
  ],
  interview: [
    "assessment",
    "recruiter_contact",
    "interview",
    "rejected",
    "offer",
    "withdrawn",
    "closed_unknown",
  ],
  rejected: [],
  offer: ["withdrawn", "closed_unknown"],
  withdrawn: [],
  closed_unknown: [],
};

export class InvalidApplicationTransitionError extends Error {
  readonly from: ApplicationState;
  readonly to: ApplicationState;

  constructor(from: ApplicationState, to: ApplicationState) {
    super(`Invalid application transition: ${from} -> ${to}`);
    this.name = "InvalidApplicationTransitionError";
    this.from = from;
    this.to = to;
  }
}

export class UnauthorizedApplicationTransitionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UnauthorizedApplicationTransitionError";
    this.code = code;
  }
}

export type SubmissionApproval =
  | {
      kind: "human";
      reference: string;
      approvedBy: "user";
    }
  | {
      kind: "policy";
      reference: string;
      approvedBy: "system";
    };

export type TransitionAuthorization = {
  automationMode: AutomationMode;
  actor: EventActor;
  approval?: SubmissionApproval;
  verification: {
    result: "passed" | "failed" | "not_run";
    reference?: string;
  };
  sourceSubmissionAllowed: boolean;
  globalAutomationPaused: boolean;
  idempotencyKey?: string;
  eligibilityAssessmentReference?: string;
  resolvedCandidateFactReferences?: readonly string[];
};

export type ApplicationTransitionCommand = {
  from: ApplicationState;
  to: ApplicationState;
  authorization: TransitionAuthorization;
};

export function allowedTransitionsFrom(
  state: ApplicationState,
): readonly ApplicationState[] {
  return transitions[state];
}

export function canTransition(
  from: ApplicationState,
  to: ApplicationState,
): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(
  from: ApplicationState,
  to: ApplicationState,
): void {
  if (!canTransition(from, to)) {
    throw new InvalidApplicationTransitionError(from, to);
  }
}

function requireNonBlank(value: string | undefined, code: string, message: string): void {
  if (!value?.trim()) {
    throw new UnauthorizedApplicationTransitionError(code, message);
  }
}

export function assertAuthorizedTransition(
  command: ApplicationTransitionCommand,
): void {
  assertTransition(command.from, command.to);

  const { authorization, from, to } = command;

  if (
    from === "normalized" &&
    (to === "eligible" || to === "hard_stopped" || to === "needs_review")
  ) {
    requireNonBlank(
      authorization.eligibilityAssessmentReference,
      "eligibility_assessment_required",
      "An initial eligibility decision requires a persisted eligibility assessment reference.",
    );
  }

  if (
    from === "needs_review" &&
    (to === "eligible" || to === "hard_stopped")
  ) {
    requireNonBlank(
      authorization.eligibilityAssessmentReference,
      "eligibility_reevaluation_required",
      "Resolving eligibility review requires a new eligibility assessment reference.",
    );
  }

  if (
    from === "needs_review" &&
    to === "eligible" &&
    !authorization.resolvedCandidateFactReferences?.some((reference) =>
      Boolean(reference.trim()),
    )
  ) {
    throw new UnauthorizedApplicationTransitionError(
      "candidate_fact_resolution_required",
      "Clearing eligibility review requires a corrected or newly verified candidate fact reference.",
    );
  }

  if (to !== "submitting") {
    return;
  }

  if (authorization.globalAutomationPaused) {
    throw new UnauthorizedApplicationTransitionError(
      "automation_paused",
      "Submission is disabled while global automation is paused.",
    );
  }
  if (!authorization.sourceSubmissionAllowed) {
    throw new UnauthorizedApplicationTransitionError(
      "source_submission_disallowed",
      "The source policy does not permit automated submission.",
    );
  }
  if (authorization.verification.result !== "passed") {
    throw new UnauthorizedApplicationTransitionError(
      "verification_required",
      "Submission requires a passing verification result.",
    );
  }
  requireNonBlank(
    authorization.verification.reference,
    "verification_reference_required",
    "Submission requires an immutable verification result reference.",
  );
  requireNonBlank(
    authorization.idempotencyKey,
    "idempotency_key_required",
    "Submission requires an idempotency key.",
  );

  const approval = authorization.approval;
  if (!approval) {
    throw new UnauthorizedApplicationTransitionError(
      "approval_required",
      "Submission requires recorded approval evidence.",
    );
  }
  requireNonBlank(
    approval.reference,
    "approval_reference_required",
    "Submission approval must reference an immutable approval event.",
  );

  if (
    (authorization.automationMode === "manual" ||
      authorization.automationMode === "assisted") &&
    (approval.kind !== "human" || approval.approvedBy !== "user")
  ) {
    throw new UnauthorizedApplicationTransitionError(
      "human_approval_required",
      "Manual and assisted submissions require recorded user approval.",
    );
  }

  if (
    authorization.automationMode === "autonomous" &&
    (approval.kind !== "policy" || approval.approvedBy !== "system")
  ) {
    throw new UnauthorizedApplicationTransitionError(
      "policy_approval_required",
      "Autonomous submission requires a recorded policy approval decision.",
    );
  }
}

const correctableOutcomeStates = new Set<ApplicationState>([
  "rejected",
  "offer",
  "withdrawn",
  "closed_unknown",
]);

const correctedOutcomeStates = new Set<ApplicationState>([
  "confirmation_received",
  "assessment",
  "recruiter_contact",
  "interview",
  "rejected",
  "offer",
  "withdrawn",
  "closed_unknown",
]);

export type OutcomeCorrectionCommand = {
  from: ApplicationState;
  to: ApplicationState;
  actor: EventActor;
  supersededEventId: string;
  reason: string;
};

export function assertOutcomeCorrection(command: OutcomeCorrectionCommand): void {
  if (command.actor !== "user") {
    throw new UnauthorizedApplicationTransitionError(
      "user_correction_required",
      "Outcome corrections require explicit user authorization.",
    );
  }
  if (!correctableOutcomeStates.has(command.from)) {
    throw new UnauthorizedApplicationTransitionError(
      "outcome_not_correctable",
      "Only recorded outcome states can be corrected through a compensating event.",
    );
  }
  if (!correctedOutcomeStates.has(command.to)) {
    throw new UnauthorizedApplicationTransitionError(
      "invalid_corrected_outcome",
      "A correction must target a post-submission outcome state.",
    );
  }
  requireNonBlank(
    command.supersededEventId,
    "superseded_event_required",
    "An outcome correction must reference the superseded event.",
  );
  requireNonBlank(
    command.reason,
    "correction_reason_required",
    "An outcome correction requires a reason.",
  );
}
