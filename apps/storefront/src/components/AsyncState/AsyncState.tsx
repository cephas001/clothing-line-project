// apps/storefront/src/components/AsyncState/AsyncState.tsx
//
// Central presentational wrapper for the four API data states:
// Loading / Success / Empty / Error. Styling matches the storefront's existing
// mono/ink aesthetic — no new visual language is introduced here; this only
// centralizes the branches every API-backed view needs.

"use client";

import type { ReactNode } from "react";
import type { AsyncState } from "@/lib/async";

interface AsyncStateViewProps<T> {
  state: AsyncState<T>;
  /** Renders the successful data. */
  children: (data: T) => ReactNode;
  loadingLabel?: string;
  emptyLabel?: string;
  /** When provided, a "TRY AGAIN" button is rendered in the empty/error states. */
  onRetry?: () => void;
}

export default function AsyncStateView<T>({
  state,
  children,
  loadingLabel = "LOADING…",
  emptyLabel = "Nothing here yet.",
  onRetry,
}: AsyncStateViewProps<T>) {
  if (state.status === "loading") {
    return (
      // F10 audit — live-region semantics: loading is announced politely so
      // the transition out of it is perceivable without sight.
      <div
        role="status"
        aria-live="polite"
        className="flex min-h-[40vh] items-center justify-center px-4"
      >
        <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
          {loadingLabel}
        </span>
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-5 px-4 text-center">
        <span className="font-mono text-[11px] tracking-[0.1em] text-muted">
          {emptyLabel}
        </span>
        {onRetry && <RetryButton onClick={onRetry} />}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      // F10 audit — errors are assertive announcements, never silent swaps
      // that could read as an empty result.
      <div
        role="alert"
        className="flex min-h-[40vh] flex-col items-center justify-center gap-5 px-4 text-center"
      >
        <span className="font-mono text-[11px] tracking-[0.1em] text-muted">
          {state.error.message}
        </span>
        {onRetry && <RetryButton onClick={onRetry} />}
      </div>
    );
  }

  return <>{children(state.data)}</>;
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer border border-ink bg-transparent px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2"
    >
      TRY AGAIN
    </button>
  );
}