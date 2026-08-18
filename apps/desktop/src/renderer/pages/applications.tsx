import { useId, useState } from "react";
import { applicationStates } from "@us-job-agent/domain";
import type { ApplicationTimelineEvent } from "@us-job-agent/database";
import type { JobAgentApi } from "../api.ts";
import { EmptyState, QuerySection } from "../components/feedback.tsx";
import { RouteLink } from "../components/route-link.tsx";
import { formatLabel, formatTimestamp } from "../format.ts";
import { hrefs } from "../router.ts";
import { useQuery } from "../use-query.ts";

type StateFilter = "all" | (typeof applicationStates)[number];

const failureStates: ReadonlySet<string> = new Set([
  "verification_failed",
  "submission_failed",
]);

/** The most recent event that recorded a failure, or null when none has. */
export function latestFailure(
  events: readonly ApplicationTimelineEvent[],
): ApplicationTimelineEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && failureStates.has(event.toState)) return event;
  }
  return null;
}

export function ApplicationsPage({
  api,
  applicationId,
}: {
  api: JobAgentApi;
  applicationId: string | null;
}) {
  if (applicationId !== null) {
    return <ApplicationDetailPage api={api} applicationId={applicationId} />;
  }
  return <ApplicationListPage api={api} />;
}

function ApplicationListPage({ api }: { api: JobAgentApi }) {
  const filterId = useId();
  const [filter, setFilter] = useState<StateFilter>("all");
  const { state, reload } = useQuery(
    () => api.listApplications(filter === "all" ? {} : { state: filter }),
    [api, filter],
  );

  return (
    <section aria-labelledby="applications-heading">
      <h1 id="applications-heading">Applications</h1>
      <div className="toolbar">
        <label htmlFor={filterId}>State filter</label>
        <select
          id={filterId}
          value={filter}
          onChange={(event) => setFilter(event.target.value as StateFilter)}
        >
          <option value="all">All states</option>
          {applicationStates.map((applicationState) => (
            <option key={applicationState} value={applicationState}>
              {formatLabel(applicationState)}
            </option>
          ))}
        </select>
      </div>
      <QuerySection label="applications" state={state} onRetry={reload}>
        {({ applications }) =>
          applications.length === 0 ? (
            <EmptyState
              message={
                filter === "all"
                  ? "No applications tracked yet."
                  : `No applications are in the "${formatLabel(filter)}" state.`
              }
            />
          ) : (
            <table className="data-table">
              <caption className="visually-hidden">
                Tracked applications and their current lifecycle state
              </caption>
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Company</th>
                  <th scope="col">State</th>
                  <th scope="col">Automation mode</th>
                  <th scope="col">Attempt</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((application) => (
                  <tr key={application.applicationId}>
                    <th scope="row">
                      <RouteLink href={hrefs.application(application.applicationId)}>
                        {application.jobTitle}
                      </RouteLink>
                    </th>
                    <td>{application.organizationName ?? "—"}</td>
                    <td>
                      <span className={`badge badge-state-${application.currentState}`}>
                        {formatLabel(application.currentState)}
                      </span>
                    </td>
                    <td>{application.automationMode}</td>
                    <td className="numeric">{application.attemptNumber}</td>
                    <td>{formatTimestamp(application.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </QuerySection>
    </section>
  );
}

/**
 * Application detail: current state, automation mode, latest failure (if
 * any), and the full append-only event timeline.
 */
function ApplicationDetailPage({
  api,
  applicationId,
}: {
  api: JobAgentApi;
  applicationId: string;
}) {
  const { state, reload } = useQuery(
    () =>
      Promise.all([
        api.getApplication({ applicationId }),
        api.getApplicationTimeline({ applicationId }),
      ]).then(([detailResponse, timelineResponse]) => ({
        detail: detailResponse.detail,
        events: timelineResponse.events,
      })),
    [api, applicationId],
  );

  return (
    <section aria-labelledby="application-detail-heading">
      <p>
        <RouteLink href={hrefs.applications}>← All applications</RouteLink>
      </p>
      <QuerySection label="application detail" state={state} onRetry={reload}>
        {({ detail, events }) => {
          const failure = latestFailure(events);
          return (
            <>
              <h1 id="application-detail-heading">
                {detail.application.jobTitle}
                {detail.application.organizationName
                  ? ` — ${detail.application.organizationName}`
                  : ""}
              </h1>
              <dl className="fact-list">
                <div>
                  <dt>Current state</dt>
                  <dd>
                    <span className={`badge badge-state-${detail.application.currentState}`}>
                      {formatLabel(detail.application.currentState)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Automation mode</dt>
                  <dd>{detail.application.automationMode}</dd>
                </div>
                <div>
                  <dt>Attempt</dt>
                  <dd>{detail.application.attemptNumber}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatTimestamp(detail.application.createdAt)}</dd>
                </div>
                <div>
                  <dt>Last updated</dt>
                  <dd>{formatTimestamp(detail.application.updatedAt)}</dd>
                </div>
                <div>
                  <dt>Job</dt>
                  <dd>
                    <RouteLink href={hrefs.job(detail.application.jobId)}>
                      View the job posting
                    </RouteLink>
                  </dd>
                </div>
              </dl>

              <section aria-labelledby="latest-failure-heading">
                <h2 id="latest-failure-heading">Latest failure</h2>
                {failure ? (
                  <div className="feedback feedback-error" role="alert">
                    <p>
                      {formatLabel(failure.toState)} at{" "}
                      {formatTimestamp(failure.occurredAt)}: {failure.reason}
                    </p>
                  </div>
                ) : (
                  <p>No failures recorded for this application.</p>
                )}
              </section>

              <section aria-labelledby="timeline-heading">
                <h2 id="timeline-heading">Timeline</h2>
                <p className="placeholder-note">
                  Events are append-only. Corrections appear as new compensating
                  events; history is never rewritten.
                </p>
                <ol className="event-list">
                  {events.map((event) => (
                    <li key={event.eventId}>
                      <p className="event-headline">
                        <span className="event-sequence">#{event.sequenceNumber}</span>{" "}
                        <span className="event-type">{formatLabel(event.eventType)}</span>{" "}
                        {event.fromState ? (
                          <>
                            <span className={`badge badge-state-${event.fromState}`}>
                              {formatLabel(event.fromState)}
                            </span>{" "}
                            <span aria-hidden="true">→</span>{" "}
                          </>
                        ) : null}
                        <span className={`badge badge-state-${event.toState}`}>
                          {formatLabel(event.toState)}
                        </span>
                      </p>
                      <p className="event-meta">
                        {formatTimestamp(event.occurredAt)} · actor: {event.actor}
                        {event.supersedesEventId
                          ? ` · supersedes event ${event.supersedesEventId}`
                          : ""}
                      </p>
                      <p className="event-reason">{event.reason}</p>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          );
        }}
      </QuerySection>
    </section>
  );
}
