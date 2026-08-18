import type { JobAgentApi } from "../api.ts";
import { EmptyState, QuerySection } from "../components/feedback.tsx";
import { RouteLink } from "../components/route-link.tsx";
import { formatLabel, formatTimestamp } from "../format.ts";
import { hrefs } from "../router.ts";
import { useQuery } from "../use-query.ts";

export function DashboardPage({ api }: { api: JobAgentApi }) {
  const { state, reload } = useQuery(() => api.getDashboardMetrics(), [api]);

  return (
    <section aria-labelledby="dashboard-heading">
      <h1 id="dashboard-heading">Dashboard</h1>
      <QuerySection label="dashboard metrics" state={state} onRetry={reload}>
        {(metrics) => (
          <div className="dashboard-grid">
            <section aria-labelledby="dashboard-states-heading">
              <h2 id="dashboard-states-heading">Applications by state</h2>
              {metrics.applicationStateCounts.length === 0 ? (
                <EmptyState message="No applications yet. Discovered jobs will appear here once they are tracked." />
              ) : (
                <ul className="stat-cards">
                  {metrics.applicationStateCounts.map((entry) => (
                    <li key={entry.state} className="stat-card">
                      <span className="stat-value">{entry.count}</span>
                      <span className="stat-label">{formatLabel(entry.state)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="dashboard-automation-heading">
              <h2 id="dashboard-automation-heading">Automation</h2>
              <p role="status" className={metrics.automationPaused ? "automation-paused" : "automation-running"}>
                {metrics.automationPaused
                  ? "Automation is paused."
                  : "Automation is running."}
              </p>
              <RouteLink href={hrefs.settings}>Manage automation in Settings</RouteLink>
            </section>

            <section aria-labelledby="dashboard-reviews-heading">
              <h2 id="dashboard-reviews-heading">Unresolved reviews</h2>
              <p>
                {metrics.openReviewItemCount === 0
                  ? "No review items are waiting."
                  : `${metrics.openReviewItemCount} review item${
                      metrics.openReviewItemCount === 1 ? "" : "s"
                    } waiting for a decision.`}
              </p>
              <RouteLink href={hrefs.reviews}>Open the review queue</RouteLink>
            </section>

            <section aria-labelledby="dashboard-events-heading">
              <h2 id="dashboard-events-heading">Recent application events</h2>
              {metrics.recentEvents.length === 0 ? (
                <EmptyState message="No application events recorded yet." />
              ) : (
                <ol className="event-list">
                  {metrics.recentEvents.map((event) => (
                    <li key={event.eventId}>
                      <p className="event-headline">
                        <span className="event-type">{formatLabel(event.eventType)}</span>{" "}
                        <span className={`badge badge-state-${event.toState}`}>
                          {formatLabel(event.toState)}
                        </span>
                      </p>
                      <p className="event-meta">
                        {formatTimestamp(event.occurredAt)} · {event.actor} ·{" "}
                        <RouteLink href={hrefs.application(event.applicationId)}>
                          view application
                        </RouteLink>
                      </p>
                      <p className="event-reason">{event.reason}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </QuerySection>
    </section>
  );
}
