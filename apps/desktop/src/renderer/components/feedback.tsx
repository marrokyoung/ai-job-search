import type { ReactNode } from "react";
import type { QueryState } from "../use-query.ts";

export function LoadingState({ label }: { label: string }) {
  return (
    <p className="feedback feedback-loading" role="status">
      Loading {label}…
    </p>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="feedback feedback-error" role="alert">
      <p>Something went wrong: {message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <p className="feedback feedback-empty">{message}</p>;
}

export function NotFoundState({ message }: { message: string }) {
  return (
    <div className="feedback feedback-not-found" role="alert">
      <p>Not found. {message}</p>
    </div>
  );
}

/**
 * Renders the loading / error / not-found states of a query and hands the
 * ready data to `children`. Every data-backed section of the app goes through
 * this so the states stay consistent.
 */
export function QuerySection<T>({
  label,
  state,
  onRetry,
  children,
}: {
  label: string;
  state: QueryState<T>;
  onRetry?: () => void;
  children: (data: T) => ReactNode;
}): ReactNode {
  if (state.status === "loading") return <LoadingState label={label} />;
  if (state.status === "error") {
    if (state.code === "not_found") return <NotFoundState message={state.message} />;
    return <ErrorState message={state.message} {...(onRetry ? { onRetry } : {})} />;
  }
  return children(state.data);
}
