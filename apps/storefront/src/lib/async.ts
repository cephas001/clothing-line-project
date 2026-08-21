// apps/storefront/src/lib/async.ts
//
// Central Loading / Success / Empty / Error state model for the storefront.
//
// Every API-backed view renders through a single AsyncState + AsyncStateView so
// the four states are handled uniformly (and styled consistently) instead of
// each component reimplementing loading/empty/error branches.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, isApiError, normalizeApiError } from "./api/errors";

export type AsyncState<T> =
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "empty" }
  | { status: "error"; error: ApiError };

export interface UseAsyncDataResult<T> {
  state: AsyncState<T>;
  /** Re-run the fetcher (used by retry/refresh). */
  reload: () => void;
}

/**
 * Run an async fetcher and expose it as a unified AsyncState. An array result
 * with zero items is reported as `empty` so callers do not repeat the same
 * length check everywhere. `deps` mirrors the trigger inputs — the fetcher
 * re-runs whenever one of them changes identity.
 */
export function useAsyncData<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[] = [],
): UseAsyncDataResult<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });

  // Keep the latest fetcher in a ref so `load` always runs the freshest
  // closure; the ref is updated in an effect (never during render).
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  // `version` is bumped by `reload` to trigger a re-run without changing deps.
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // Run on mount and whenever `deps` or `version` changes. The dependency list
  // is intentionally a literal with a spread of the caller's trigger inputs.
  // State is only ever updated in the promise callbacks (never synchronously
  // in the effect body), so `loading` is the initial state and subsequent runs
  // keep the last result visible until the new one resolves.
  useEffect(() => {
    let cancelled = false;
    fetcherRef.current().then(
      (data) => {
        if (cancelled) return;
        setState(
          Array.isArray(data) && data.length === 0
            ? { status: "empty" }
            : { status: "success", data },
        );
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          error: isApiError(error) ? error : normalizeApiError(error),
        });
      },
    );
    return () => {
      cancelled = true;
    };
    // `deps` describes the fetcher's own trigger inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps]);

  return { state, reload };
}