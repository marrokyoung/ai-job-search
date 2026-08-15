import {
  ReadModelQueries,
  ReviewItemNotFoundError,
  ReviewItemNotOpenError,
  ReviewRepository,
  SettingsRepository,
  type ApplicationDetail,
  type ApplicationSummary,
  type ApplicationTimelineEvent,
  type DashboardMetrics,
  type JobAgentDatabase,
  type JobDetail,
  type JobSummary,
  type ReviewItemView,
} from "@us-job-agent/database";
import type {
  CreateReviewItemRequest,
  DesktopSettingsView,
  EmptyRequest,
  GetApplicationRequest,
  GetApplicationTimelineRequest,
  GetJobRequest,
  IpcErrorCode,
  ListApplicationsRequest,
  ListJobsRequest,
  ListReviewItemsRequest,
  ResolveReviewItemRequest,
  SetAutomationPausedRequest,
  UpdateSettingsRequest,
} from "../shared/ipc-contract.ts";

/**
 * An expected, renderer-visible failure. Anything else thrown by a service is
 * treated as internal and never forwarded to the renderer verbatim.
 */
export class ServiceError extends Error {
  constructor(
    readonly code: Exclude<IpcErrorCode, "internal" | "untrusted_sender">,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export type DesktopServices = {
  getDashboardMetrics(request: EmptyRequest): DashboardMetrics;
  listJobs(request: ListJobsRequest): { jobs: JobSummary[] };
  getJob(request: GetJobRequest): { detail: JobDetail };
  listApplications(request: ListApplicationsRequest): {
    applications: ApplicationSummary[];
  };
  getApplication(request: GetApplicationRequest): { detail: ApplicationDetail };
  getApplicationTimeline(request: GetApplicationTimelineRequest): {
    events: ApplicationTimelineEvent[];
  };
  listReviewItems(request: ListReviewItemsRequest): { reviewItems: ReviewItemView[] };
  createReviewItem(request: CreateReviewItemRequest): { reviewItemId: string };
  resolveReviewItem(request: ResolveReviewItemRequest): { reviewItem: ReviewItemView };
  getSettings(request: EmptyRequest): { settings: DesktopSettingsView };
  updateSettings(request: UpdateSettingsRequest): { settings: DesktopSettingsView };
  setAutomationPaused(request: SetAutomationPausedRequest): {
    settings: DesktopSettingsView;
  };
};

export function createDesktopServices(dependencies: {
  getDatabase: () => JobAgentDatabase;
  dataDirectory: string;
}): DesktopServices {
  const queries = () => new ReadModelQueries(dependencies.getDatabase());
  const reviews = () => new ReviewRepository(dependencies.getDatabase());
  const settings = () => new SettingsRepository(dependencies.getDatabase());
  const withDataDirectory = (view: Omit<DesktopSettingsView, "dataDirectory">) => ({
    settings: { ...view, dataDirectory: dependencies.dataDirectory },
  });

  return {
    getDashboardMetrics() {
      return queries().getDashboardMetrics();
    },
    listJobs(request) {
      return { jobs: queries().listJobs(request) };
    },
    getJob(request) {
      const detail = queries().getJobDetail(request.jobId);
      if (!detail) {
        throw new ServiceError("not_found", `Job ${request.jobId} was not found.`);
      }
      return { detail };
    },
    listApplications(request) {
      return { applications: queries().listApplications(request) };
    },
    getApplication(request) {
      const detail = queries().getApplicationDetail(request.applicationId);
      if (!detail) {
        throw new ServiceError(
          "not_found",
          `Application ${request.applicationId} was not found.`,
        );
      }
      return { detail };
    },
    getApplicationTimeline(request) {
      const events = queries().getApplicationTimeline(request.applicationId);
      if (!events) {
        throw new ServiceError(
          "not_found",
          `Application ${request.applicationId} was not found.`,
        );
      }
      return { events };
    },
    listReviewItems(request) {
      return { reviewItems: reviews().list(request) };
    },
    createReviewItem(request) {
      return { reviewItemId: reviews().create(request) };
    },
    resolveReviewItem(request) {
      try {
        return { reviewItem: reviews().resolve(request) };
      } catch (error) {
        if (error instanceof ReviewItemNotFoundError) {
          throw new ServiceError("not_found", error.message);
        }
        if (error instanceof ReviewItemNotOpenError) {
          throw new ServiceError("conflict", error.message);
        }
        throw error;
      }
    },
    getSettings() {
      return withDataDirectory(settings().get());
    },
    updateSettings(request) {
      return withDataDirectory(settings().update(request));
    },
    setAutomationPaused(request) {
      return withDataDirectory(
        settings().setPaused({
          paused: request.paused,
          reason: request.reason,
          actor: "user",
        }),
      );
    },
  };
}
