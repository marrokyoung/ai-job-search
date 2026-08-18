import { useId, useState } from "react";
import type { ReviewItemView } from "@us-job-agent/database";
import { reviewItemStatuses } from "../../shared/ipc-contract.ts";
import type { JobAgentApi } from "../api.ts";
import { EmptyState, QuerySection } from "../components/feedback.tsx";
import { ReasonDialog } from "../components/reason-dialog.tsx";
import { RouteLink } from "../components/route-link.tsx";
import { formatLabel, formatTimestamp } from "../format.ts";
import { hrefs } from "../router.ts";
import { useQuery } from "../use-query.ts";

type ReviewAction = {
  item: ReviewItemView;
  outcome: "resolved" | "dismissed";
};

export function ReviewQueuePage({ api }: { api: JobAgentApi }) {
  const filterId = useId();
  const [statusFilter, setStatusFilter] =
    useState<(typeof reviewItemStatuses)[number]>("open");
  const [pendingAction, setPendingAction] = useState<ReviewAction | null>(null);
  const { state, reload } = useQuery(
    () => api.listReviewItems({ status: statusFilter }),
    [api, statusFilter],
  );

  const submitAction = async (reason: string) => {
    if (!pendingAction) return;
    await api.resolveReviewItem({
      reviewItemId: pendingAction.item.reviewItemId,
      outcome: pendingAction.outcome,
      reason,
    });
    setPendingAction(null);
    reload();
  };

  return (
    <section aria-labelledby="reviews-heading">
      <h1 id="reviews-heading">Review queue</h1>
      <p>
        Items land here when the evaluator cannot decide on its own — unknown
        mandatory requirements, failed extractions, or invalid transition
        diagnostics. Every decision records a reason.
      </p>
      <p className="placeholder-note">
        Resolving or dismissing records your decision in this queue only; it
        does not change any application's state. An application held in "needs
        review" stays held until its eligibility is re-evaluated against
        verified candidate facts, which requires the candidate-fact ledger of a
        later phase.
      </p>
      <div className="toolbar">
        <label htmlFor={filterId}>Status filter</label>
        <select
          id={filterId}
          value={statusFilter}
          onChange={(event) =>
            setStatusFilter(event.target.value as (typeof reviewItemStatuses)[number])
          }
        >
          {reviewItemStatuses.map((status) => (
            <option key={status} value={status}>
              {formatLabel(status)}
            </option>
          ))}
        </select>
      </div>
      <QuerySection label="review items" state={state} onRetry={reload}>
        {({ reviewItems }) =>
          reviewItems.length === 0 ? (
            <EmptyState
              message={
                statusFilter === "open"
                  ? "The review queue is empty. Nothing is waiting on a decision."
                  : `No ${formatLabel(statusFilter)} review items.`
              }
            />
          ) : (
            <ul className="card-list">
              {reviewItems.map((item) => (
                <li key={item.reviewItemId} className="card">
                  <h2>{formatLabel(item.reviewType)}</h2>
                  <p>{item.summary}</p>
                  <p className="event-meta">
                    Created {formatTimestamp(item.createdAt)}
                    {item.applicationId ? (
                      <>
                        {" · "}
                        <RouteLink href={hrefs.application(item.applicationId)}>
                          view application
                        </RouteLink>
                      </>
                    ) : null}
                    {item.eligibilityAssessmentId
                      ? ` · assessment ${item.eligibilityAssessmentId}`
                      : ""}
                  </p>
                  {item.status === "open" ? (
                    <div className="card-actions">
                      <button
                        type="button"
                        onClick={() => setPendingAction({ item, outcome: "resolved" })}
                      >
                        Resolve…
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingAction({ item, outcome: "dismissed" })}
                      >
                        Dismiss…
                      </button>
                    </div>
                  ) : (
                    <p className="resolution">
                      <span className={`badge badge-review-${item.status}`}>
                        {formatLabel(item.status)}
                      </span>{" "}
                      {item.resolvedAt ? `on ${formatTimestamp(item.resolvedAt)}` : ""} —{" "}
                      {item.resolutionReason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </QuerySection>
      {pendingAction ? (
        <ReasonDialog
          title={
            pendingAction.outcome === "resolved"
              ? "Resolve review item"
              : "Dismiss review item"
          }
          description={
            pendingAction.outcome === "resolved"
              ? `Record why "${formatLabel(pendingAction.item.reviewType)}" needs no further attention. The reason is stored with this review item only — the linked application's state and eligibility are not changed.`
              : `Record why "${formatLabel(pendingAction.item.reviewType)}" is being dismissed without action. The reason is stored with this review item only — the linked application's state and eligibility are not changed.`
          }
          submitLabel={pendingAction.outcome === "resolved" ? "Resolve" : "Dismiss"}
          onSubmit={submitAction}
          onCancel={() => setPendingAction(null)}
        />
      ) : null}
    </section>
  );
}
