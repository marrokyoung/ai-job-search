import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { JobSummary } from "@us-job-agent/database";
import { eligibilityStatuses } from "../../shared/ipc-contract.ts";
import type { JobAgentApi } from "../api.ts";
import { EmptyState, QuerySection } from "../components/feedback.tsx";
import { RouteLink } from "../components/route-link.tsx";
import { formatLabel, formatTimestamp } from "../format.ts";
import { hrefs, navigate } from "../router.ts";
import { useQuery } from "../use-query.ts";

type EligibilityFilter = "all" | (typeof eligibilityStatuses)[number];

type SortKey = "title" | "organizationName" | "capturedAt" | "eligibilityStatus" | "softGapCount";
type SortDirection = "ascending" | "descending";

const sortableColumns: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "title", label: "Title" },
  { key: "organizationName", label: "Company" },
  { key: "capturedAt", label: "Captured" },
  { key: "eligibilityStatus", label: "Eligibility" },
  { key: "softGapCount", label: "Soft gaps" },
];

function compareJobs(a: JobSummary, b: JobSummary, key: SortKey): number {
  if (key === "softGapCount") return a.softGapCount - b.softGapCount;
  const left = a[key] ?? "";
  const right = b[key] ?? "";
  return left.localeCompare(right);
}

export function JobsPage({ api, jobId }: { api: JobAgentApi; jobId: string | null }) {
  const filterId = useId();
  const [filter, setFilter] = useState<EligibilityFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("capturedAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("descending");
  const { state, reload } = useQuery(
    () => api.listJobs(filter === "all" ? {} : { eligibility: filter }),
    [api, filter],
  );

  const sorted = useMemo(() => {
    if (state.status !== "ready") return [];
    const jobs = [...state.data.jobs].sort((a, b) => compareJobs(a, b, sortKey));
    if (sortDirection === "descending") jobs.reverse();
    return jobs;
  }, [state, sortKey, sortDirection]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDirection((direction) =>
        direction === "ascending" ? "descending" : "ascending",
      );
    } else {
      setSortKey(key);
      setSortDirection("ascending");
    }
  };

  return (
    <section aria-labelledby="jobs-heading">
      <h1 id="jobs-heading">Jobs</h1>
      <div className="toolbar">
        <label htmlFor={filterId}>Eligibility filter</label>
        <select
          id={filterId}
          value={filter}
          onChange={(event) => setFilter(event.target.value as EligibilityFilter)}
        >
          <option value="all">All jobs</option>
          {eligibilityStatuses.map((status) => (
            <option key={status} value={status}>
              {formatLabel(status)}
            </option>
          ))}
        </select>
      </div>
      <QuerySection label="jobs" state={state} onRetry={reload}>
        {() =>
          sorted.length === 0 ? (
            <EmptyState
              message={
                filter === "all"
                  ? "No jobs tracked yet."
                  : `No jobs match the "${formatLabel(filter)}" filter.`
              }
            />
          ) : (
            <table className="data-table">
              <caption className="visually-hidden">
                Tracked jobs with their latest eligibility assessment
              </caption>
              <thead>
                <tr>
                  {sortableColumns.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={column.key === sortKey ? sortDirection : undefined}
                    >
                      <button
                        type="button"
                        className="sort-button"
                        onClick={() => onSort(column.key)}
                      >
                        {column.label}
                      </button>
                    </th>
                  ))}
                  <th scope="col">Location</th>
                  <th scope="col">Application</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((job) => (
                  <tr key={job.jobId}>
                    <th scope="row">
                      <RouteLink href={hrefs.job(job.jobId)}>{job.title}</RouteLink>
                    </th>
                    <td>{job.organizationName ?? "—"}</td>
                    <td>{formatTimestamp(job.capturedAt)}</td>
                    <td>
                      {job.eligibilityStatus === null ? (
                        <span className="badge badge-unassessed">not assessed</span>
                      ) : (
                        <span className={`badge badge-${job.eligibilityStatus}`}>
                          {formatLabel(job.eligibilityStatus)}
                        </span>
                      )}
                    </td>
                    <td className="numeric">{job.softGapCount}</td>
                    <td>
                      {job.locationText ?? "—"} ({formatLabel(job.workplaceType)})
                    </td>
                    <td>
                      {job.applicationId && job.applicationState ? (
                        <RouteLink href={hrefs.application(job.applicationId)}>
                          {formatLabel(job.applicationState)}
                        </RouteLink>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </QuerySection>
      {jobId !== null ? (
        <JobDetailDrawer api={api} jobId={jobId} onClose={() => navigate(hrefs.jobs)} />
      ) : null}
    </section>
  );
}

/**
 * Job detail as a route-backed drawer (`#/jobs/<id>`): assessments for the
 * latest posting snapshot, soft-gap summary, and the posting description.
 * Escape or the close button returns to the list route.
 */
function JobDetailDrawer({
  api,
  jobId,
  onClose,
}: {
  api: JobAgentApi;
  jobId: string;
  onClose: () => void;
}) {
  const headingId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const { state, reload } = useQuery(() => api.getJob({ jobId }), [api, jobId]);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      previouslyFocused?.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <aside
      className="drawer"
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
    >
      <div className="drawer-header">
        <h2 id={headingId}>Job detail</h2>
        <button type="button" ref={closeRef} onClick={onClose}>
          Close
        </button>
      </div>
      <QuerySection label="job detail" state={state} onRetry={reload}>
        {({ detail }) => (
          <div className="drawer-body">
            <h3>{detail.job.title}</h3>
            <dl className="fact-list">
              <div>
                <dt>Company</dt>
                <dd>{detail.job.organizationName ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Location</dt>
                <dd>
                  {detail.job.locationText ?? "Unknown"} (
                  {formatLabel(detail.job.workplaceType)})
                </dd>
              </div>
              <div>
                <dt>Employment type</dt>
                <dd>{detail.job.employmentType ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{detail.job.sourceDisplayName}</dd>
              </div>
              <div>
                <dt>Posting URL</dt>
                <dd>
                  <code>{detail.job.canonicalUrl ?? "none recorded"}</code>
                </dd>
              </div>
              <div>
                <dt>Snapshot captured</dt>
                <dd>{formatTimestamp(detail.job.capturedAt)}</dd>
              </div>
              <div>
                <dt>Eligibility</dt>
                <dd>
                  {detail.job.eligibilityStatus === null ? (
                    <span className="badge badge-unassessed">not assessed</span>
                  ) : (
                    <span className={`badge badge-${detail.job.eligibilityStatus}`}>
                      {formatLabel(detail.job.eligibilityStatus)}
                    </span>
                  )}
                  {` · ${detail.job.softGapCount} soft gap${
                    detail.job.softGapCount === 1 ? "" : "s"
                  }`}
                </dd>
              </div>
            </dl>

            <section aria-label="Requirement assessments">
              <h4>Requirement assessments</h4>
              {detail.assessments.length === 0 ? (
                <EmptyState message="No requirement assessment exists for this posting yet." />
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Requirement</th>
                      <th scope="col">Category</th>
                      <th scope="col">Severity</th>
                      <th scope="col">Mandatory</th>
                      <th scope="col">Explanation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.assessments.map((assessment) => (
                      <tr key={assessment.requirementText}>
                        <th scope="row">{assessment.requirementText}</th>
                        <td>{formatLabel(assessment.category)}</td>
                        <td>
                          <span className={`badge badge-severity-${assessment.severity}`}>
                            {formatLabel(assessment.severity)}
                          </span>
                        </td>
                        <td>{assessment.mandatory ? "yes" : "no"}</td>
                        <td>{assessment.explanation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="placeholder-note">
                Evidence excerpts will appear here once the requirement extractor
                records source spans (a later phase).
              </p>
            </section>

            <section aria-label="Posting description">
              <h4>Posting description</h4>
              <p className="description-text">{detail.descriptionText}</p>
            </section>
          </div>
        )}
      </QuerySection>
    </aside>
  );
}
