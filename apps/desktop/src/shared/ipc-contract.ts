/**
 * The single source of truth for the renderer/main IPC boundary.
 *
 * Every channel is declared here with a runtime validator for its request and
 * its response. The preload bridge derives its method surface from this table
 * (it can only reach declared channels) and the main-process router derives
 * its handler registrations from it (it only answers declared channels).
 */
import { applicationStates, requirementCategories } from "@us-job-agent/domain";
import type {
  ApplicationDetail,
  ApplicationSummary,
  ApplicationTimelineEvent,
  AutomationSettingsView,
  DashboardMetrics,
  JobDetail,
  JobRequirementAssessmentView,
  JobSummary,
  ReviewItemView,
} from "@us-job-agent/database";
import {
  vArray,
  vBoolean,
  vEnum,
  vInteger,
  vNullable,
  vObject,
  vOptional,
  vRefine,
  vString,
  type Validator,
} from "./validation.ts";

export const eligibilityStatuses = ["eligible", "blocked", "needs_review"] as const;
export const automationModes = ["manual", "assisted", "autonomous"] as const;
export const eventActors = ["user", "agent", "system", "external"] as const;
export const requirementSeverities = ["satisfied", "soft_gap", "hard_stop", "unknown"] as const;
export const workplaceTypes = ["remote", "hybrid", "onsite", "unknown"] as const;
export const reviewItemStatuses = ["open", "resolved", "dismissed"] as const;
export const reviewOutcomes = ["resolved", "dismissed"] as const;

/** Non-secret settings shown to the renderer, including the local data path. */
export type DesktopSettingsView = AutomationSettingsView & { dataDirectory: string };

export type EmptyRequest = Record<string, never>;
export type ListJobsRequest = {
  eligibility?: (typeof eligibilityStatuses)[number];
  limit?: number;
};
export type GetJobRequest = { jobId: string };
export type ListApplicationsRequest = {
  state?: (typeof applicationStates)[number];
  limit?: number;
};
export type GetApplicationRequest = { applicationId: string };
export type GetApplicationTimelineRequest = { applicationId: string };
export type ListReviewItemsRequest = {
  status?: (typeof reviewItemStatuses)[number];
  limit?: number;
};
export type CreateReviewItemRequest = {
  applicationId?: string;
  eligibilityAssessmentId?: string;
  reviewType: string;
  summary: string;
};
export type ResolveReviewItemRequest = {
  reviewItemId: string;
  outcome: (typeof reviewOutcomes)[number];
  reason: string;
};
export type UpdateSettingsRequest = {
  defaultMode?: (typeof automationModes)[number];
  dailyApplicationLimit?: number;
};
export type SetAutomationPausedRequest = { paused: boolean; reason: string };

const emptyRequest = vObject<EmptyRequest>({});
const isoText = vString({ nonBlank: true, maxLength: 64 });
const identifier = vString({ nonBlank: true, maxLength: 200 });
const listLimit = vOptional(vInteger({ min: 1, max: 500 }));

const timelineEventValidator = vObject<ApplicationTimelineEvent>({
  eventId: identifier,
  applicationId: identifier,
  sequenceNumber: vInteger({ min: 1 }),
  eventType: vString({ nonBlank: true, maxLength: 100 }),
  actor: vEnum(eventActors),
  fromState: vNullable(vEnum(applicationStates)),
  toState: vEnum(applicationStates),
  occurredAt: isoText,
  reason: vString(),
  correlationId: vNullable(vString({ maxLength: 200 })),
  supersedesEventId: vNullable(vString({ maxLength: 200 })),
});

const jobSummaryValidator = vObject<JobSummary>({
  jobId: identifier,
  sourceKey: vString({ nonBlank: true, maxLength: 100 }),
  sourceDisplayName: vString({ maxLength: 200 }),
  organizationName: vNullable(vString({ maxLength: 300 })),
  canonicalUrl: vNullable(vString({ maxLength: 2000 })),
  snapshotId: identifier,
  title: vString({ maxLength: 500 }),
  locationText: vNullable(vString({ maxLength: 500 })),
  workplaceType: vEnum(workplaceTypes),
  employmentType: vNullable(vString({ maxLength: 100 })),
  capturedAt: isoText,
  eligibilityStatus: vNullable(vEnum(eligibilityStatuses)),
  softGapCount: vInteger({ min: 0 }),
  applicationId: vNullable(vString({ maxLength: 200 })),
  applicationState: vNullable(vEnum(applicationStates)),
});

const requirementAssessmentValidator = vObject<JobRequirementAssessmentView>({
  requirementText: vString(),
  category: vEnum(requirementCategories),
  severity: vEnum(requirementSeverities),
  mandatory: vBoolean(),
  explanation: vString(),
});

const jobDetailValidator = vObject<JobDetail>({
  job: jobSummaryValidator,
  descriptionText: vString({ maxLength: 200_000 }),
  assessments: vArray(requirementAssessmentValidator),
});

const applicationSummaryValidator = vObject<ApplicationSummary>({
  applicationId: identifier,
  jobId: identifier,
  jobTitle: vString({ maxLength: 500 }),
  organizationName: vNullable(vString({ maxLength: 300 })),
  currentState: vEnum(applicationStates),
  automationMode: vEnum(automationModes),
  attemptNumber: vInteger({ min: 1 }),
  createdAt: isoText,
  updatedAt: isoText,
});

const applicationDetailValidator = vObject<ApplicationDetail>({
  application: applicationSummaryValidator,
  jobSnapshotId: identifier,
  latestEvent: timelineEventValidator,
});

const reviewItemValidator = vObject<ReviewItemView>({
  reviewItemId: identifier,
  applicationId: vNullable(vString({ maxLength: 200 })),
  eligibilityAssessmentId: vNullable(vString({ maxLength: 200 })),
  reviewType: vString({ nonBlank: true, maxLength: 100 }),
  status: vEnum(reviewItemStatuses),
  summary: vString(),
  resolutionReason: vNullable(vString()),
  createdAt: isoText,
  resolvedAt: vNullable(isoText),
});

const dashboardMetricsValidator = vObject<DashboardMetrics>({
  applicationStateCounts: vArray(
    vObject<{ state: (typeof applicationStates)[number]; count: number }>({
      state: vEnum(applicationStates),
      count: vInteger({ min: 0 }),
    }),
  ),
  openReviewItemCount: vInteger({ min: 0 }),
  automationPaused: vBoolean(),
  recentEvents: vArray(timelineEventValidator),
});

const settingsValidator = vObject<DesktopSettingsView>({
  automationPaused: vBoolean(),
  defaultMode: vEnum(automationModes),
  dailyApplicationLimit: vInteger({ min: 0 }),
  updatedAt: isoText,
  dataDirectory: vString({ nonBlank: true, maxLength: 1000 }),
});

export type ChannelDefinition = {
  /** The preload/service method name this channel is exposed as. */
  method: string;
  request: Validator<unknown>;
  response: Validator<unknown>;
};

export const ipcChannels = {
  "dashboard:getMetrics": {
    method: "getDashboardMetrics",
    request: emptyRequest,
    response: dashboardMetricsValidator,
  },
  "jobs:list": {
    method: "listJobs",
    request: vObject<ListJobsRequest>({
      eligibility: vOptional(vEnum(eligibilityStatuses)),
      limit: listLimit,
    }),
    response: vObject<{ jobs: JobSummary[] }>({ jobs: vArray(jobSummaryValidator) }),
  },
  "jobs:get": {
    method: "getJob",
    request: vObject<GetJobRequest>({ jobId: identifier }),
    response: vObject<{ detail: JobDetail }>({ detail: jobDetailValidator }),
  },
  "applications:list": {
    method: "listApplications",
    request: vObject<ListApplicationsRequest>({
      state: vOptional(vEnum(applicationStates)),
      limit: listLimit,
    }),
    response: vObject<{ applications: ApplicationSummary[] }>({
      applications: vArray(applicationSummaryValidator),
    }),
  },
  "applications:get": {
    method: "getApplication",
    request: vObject<GetApplicationRequest>({ applicationId: identifier }),
    response: vObject<{ detail: ApplicationDetail }>({
      detail: applicationDetailValidator,
    }),
  },
  "applications:getTimeline": {
    method: "getApplicationTimeline",
    request: vObject<GetApplicationTimelineRequest>({ applicationId: identifier }),
    response: vObject<{ events: ApplicationTimelineEvent[] }>({
      events: vArray(timelineEventValidator),
    }),
  },
  "reviews:list": {
    method: "listReviewItems",
    request: vObject<ListReviewItemsRequest>({
      status: vOptional(vEnum(reviewItemStatuses)),
      limit: listLimit,
    }),
    response: vObject<{ reviewItems: ReviewItemView[] }>({
      reviewItems: vArray(reviewItemValidator),
    }),
  },
  "reviews:create": {
    method: "createReviewItem",
    request: vRefine(
      vObject<CreateReviewItemRequest>({
        applicationId: vOptional(identifier),
        eligibilityAssessmentId: vOptional(identifier),
        reviewType: vString({ nonBlank: true, maxLength: 100 }),
        summary: vString({ nonBlank: true, maxLength: 5_000 }),
      }),
      (request) =>
        (request.applicationId === undefined) !==
        (request.eligibilityAssessmentId === undefined),
      "a review item must reference exactly one subject: an application or an eligibility assessment",
    ),
    response: vObject<{ reviewItemId: string }>({ reviewItemId: identifier }),
  },
  "reviews:resolve": {
    method: "resolveReviewItem",
    request: vObject<ResolveReviewItemRequest>({
      reviewItemId: identifier,
      outcome: vEnum(reviewOutcomes),
      reason: vString({ nonBlank: true, maxLength: 5_000 }),
    }),
    response: vObject<{ reviewItem: ReviewItemView }>({ reviewItem: reviewItemValidator }),
  },
  "settings:get": {
    method: "getSettings",
    request: emptyRequest,
    response: vObject<{ settings: DesktopSettingsView }>({ settings: settingsValidator }),
  },
  "settings:update": {
    method: "updateSettings",
    request: vRefine(
      vObject<UpdateSettingsRequest>({
        defaultMode: vOptional(vEnum(automationModes)),
        dailyApplicationLimit: vOptional(vInteger({ min: 0, max: 1_000 })),
      }),
      (request) =>
        request.defaultMode !== undefined || request.dailyApplicationLimit !== undefined,
      "a settings update must change at least one field",
    ),
    response: vObject<{ settings: DesktopSettingsView }>({ settings: settingsValidator }),
  },
  "automation:setPaused": {
    method: "setAutomationPaused",
    request: vObject<SetAutomationPausedRequest>({
      paused: vBoolean(),
      reason: vString({ nonBlank: true, maxLength: 5_000 }),
    }),
    response: vObject<{ settings: DesktopSettingsView }>({ settings: settingsValidator }),
  },
} as const satisfies Record<string, ChannelDefinition>;

export type IpcChannel = keyof typeof ipcChannels;
export type PreloadMethodName = (typeof ipcChannels)[IpcChannel]["method"];

export const ipcChannelNames = Object.freeze(
  Object.keys(ipcChannels),
) as readonly IpcChannel[];

export type IpcErrorCode =
  | "invalid_request"
  | "untrusted_sender"
  | "not_found"
  | "conflict"
  | "internal";

export type IpcFailure = {
  ok: false;
  error: { code: IpcErrorCode; message: string };
};
export type IpcSuccess<T> = { ok: true; data: T };
export type IpcEnvelope<T> = IpcSuccess<T> | IpcFailure;

/**
 * The full renderer-facing API. The preload script exposes exactly this
 * surface (and nothing else) as `window.jobAgent`.
 */
export type JobAgentApi = {
  getDashboardMetrics(): Promise<DashboardMetrics>;
  listJobs(request?: ListJobsRequest): Promise<{ jobs: JobSummary[] }>;
  getJob(request: GetJobRequest): Promise<{ detail: JobDetail }>;
  listApplications(
    request?: ListApplicationsRequest,
  ): Promise<{ applications: ApplicationSummary[] }>;
  getApplication(request: GetApplicationRequest): Promise<{ detail: ApplicationDetail }>;
  getApplicationTimeline(
    request: GetApplicationTimelineRequest,
  ): Promise<{ events: ApplicationTimelineEvent[] }>;
  listReviewItems(
    request?: ListReviewItemsRequest,
  ): Promise<{ reviewItems: ReviewItemView[] }>;
  createReviewItem(request: CreateReviewItemRequest): Promise<{ reviewItemId: string }>;
  resolveReviewItem(
    request: ResolveReviewItemRequest,
  ): Promise<{ reviewItem: ReviewItemView }>;
  getSettings(): Promise<{ settings: DesktopSettingsView }>;
  updateSettings(request: UpdateSettingsRequest): Promise<{ settings: DesktopSettingsView }>;
  setAutomationPaused(
    request: SetAutomationPausedRequest,
  ): Promise<{ settings: DesktopSettingsView }>;
};
