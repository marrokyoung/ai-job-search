import { useCallback, useEffect, useState } from "react";

export type QueryError = { code: string; message: string };

export type QueryState<T> =
  | { status: "loading" }
  | ({ status: "error" } & QueryError)
  | { status: "ready"; data: T };

/**
 * Splits the "code: message" errors thrown by the preload bridge back into
 * their parts so pages can distinguish not-found from other failures.
 */
export function toQueryError(error: unknown): QueryError {
  const text = error instanceof Error ? error.message : "The request failed.";
  const match = /^([a-z_]+): (.+)$/s.exec(text);
  if (match?.[1] && match[2]) return { code: match[1], message: match[2] };
  return { code: "unknown", message: text };
}

/**
 * Loads data over the preload bridge with explicit loading/error/ready
 * states. Reruns when `deps` change; `reload` reruns with the same deps.
 * Stale responses (superseded by a dep change or unmount) are dropped.
 */
export function useQuery<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
): { state: QueryState<T>; reload: () => void } {
  const [state, setState] = useState<QueryState<T>>({ status: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let stale = false;
    setState({ status: "loading" });
    load().then(
      (data) => {
        if (!stale) setState({ status: "ready", data });
      },
      (error: unknown) => {
        if (!stale) setState({ status: "error", ...toQueryError(error) });
      },
    );
    return () => {
      stale = true;
    };
    // The caller owns the dependency list; `load` itself is intentionally not
    // a dependency so inline closures do not refetch every render.
  }, [...deps, generation]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { state, reload };
}
