// apps/storefront/src/lib/cartMutations.ts
//
// F8 Part 2 — pure cart-mutation planning rules.
//
// The cart context serializes every mutation on the FIFO queue and keeps an
// optimistic quantity overlay (identity/quantity only — never money). These
// helpers decide, PURELY, what a +/- click or a REMOVE click means given the
// last reconciled server quantity and the overlay state:
//
//   - Rapid clicks ACCUMULATE: each plan computes its target from
//     (server quantity + pending overlay + delta), never from a stale
//     intermediate value.
//   - A quantity driven to (or below) zero becomes a REMOVE — one DELETE,
//     not an invalid zero-quantity PATCH.
//   - A removal that is ALREADY queued is a NO-OP: re-enqueuing would fire a
//     second DELETE against a deleted line and surface a spurious 404 error
//     to the customer. The overlay driving a line to zero IS the busy state
//     of the removal (the line disappears immediately).
//
// No React, no HTTP, no money math — quantities and indices only.

export interface QuantityOverlayState {
  /** Last reconciled SERVER quantity for the line (>= 0). */
  currentQty: number;
  /** Current optimistic overlay delta for the line (negative while removing). */
  pendingDelta: number;
}

export type MutationPlan =
  | { action: "update"; target: number; nextPending: number }
  | { action: "remove"; target: 0; nextPending: number }
  | { action: "noop"; target: number; nextPending: number };

/** True when a REMOVE for this line is already reflected in the overlay. */
export function isRemovalQueued(state: QuantityOverlayState): boolean {
  return state.pendingDelta <= -Math.max(0, state.currentQty);
}

/**
 * Plan a +/- click. The target accumulates on top of the pending overlay so
 * bursts of clicks coalesce into queued server operations instead of
 * overwriting each other. Crossing zero converts the plan into a removal —
 * unless a removal is already queued, in which case the click is a no-op.
 */
export function planQuantityChange(
  state: QuantityOverlayState,
  delta: number,
): MutationPlan {
  if (isRemovalQueued(state)) {
    return { action: "noop", target: 0, nextPending: state.pendingDelta };
  }
  const target = state.currentQty + state.pendingDelta + delta;
  if (target <= 0) {
    return {
      action: "remove",
      target: 0,
      // The overlay REPLACES the displayed quantity: driving it to exactly
      // -(server quantity) hides the line regardless of the current pending.
      nextPending: -Math.max(0, state.currentQty),
    };
  }
  return { action: "update", target, nextPending: state.pendingDelta + delta };
}

/**
 * Plan an explicit REMOVE click. Idempotent: a second click while the first
 * removal is still queued (or before the reconcile lands) is a no-op, so a
 * double-click can never produce a duplicate DELETE / spurious error toast.
 */
export function planRemoval(state: QuantityOverlayState): MutationPlan {
  if (isRemovalQueued(state)) {
    return { action: "noop", target: 0, nextPending: state.pendingDelta };
  }
  return {
    action: "remove",
    target: 0,
    // Drive the displayed quantity to exactly zero regardless of any pending
    // +/- overlay: -(server quantity) always hides the line.
    nextPending: -Math.max(0, state.currentQty),
  };
}
