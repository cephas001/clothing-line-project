// apps/api/src/domain/shared/trackingStateMachine.ts

// Explicit lifecycle of a shipment's COURIER TRACKING state.
//
// This is a SEPARATE axis from the DISPATCH lifecycle
// (domain/shared/dispatchStateMachine.ts): `status` on a fulfillment record
// carries the DISPATCH state (`dispatch_pending`, `dispatched`,
// `requires_reconciliation`, ...), while the courier tracking progress is
// persisted as structured metadata (`metadata.tracking`) and driven through
// THIS machine. Mixing the two axes into one string field would corrupt the
// dispatch gate, so they are deliberately kept apart.
//
// The worker maps provider events onto this vocabulary (PART 11) and applies
// transitions through `CourierTrackingStateMachine.next(...)` — arbitrary
// string assignments are never used (PART 12):
//   - `in_transit`        — shipment is moving (picked_up / scanned / en route);
//   - `out_for_delivery`  — out on the final delivery leg;
//   - `delivered`         — delivered to the destination (TERMINAL);
//   - `delivery_failed`   — a delivery attempt failed (a later re-attempt may
//                           legitimately move the shipment forward again).
//
// Impossible BACKWARDS transitions are rejected with INVALID_STATUS_TRANSITION
// (e.g. `delivered` -> `in_transit`), and same-state transitions are
// idempotent (the machine returns the same state; the worker treats a
// no-op change as an idempotent, already-handled event).

import { DomainError } from "@api/domain/entities/errors/DomainError";

/** Courier tracking progress state of a shipment (see module doc). */
export type CourierTrackingState =
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "delivery_failed";

/** Tracking-progress event the worker applies (normalized from provider events). */
export type CourierTrackingEvent =
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "delivery_failed";

const TRANSITIONS: Record<
  CourierTrackingState,
  Partial<Record<CourierTrackingEvent, CourierTrackingState>>
> = {
  in_transit: {
    in_transit: "in_transit",
    out_for_delivery: "out_for_delivery",
    delivered: "delivered",
    delivery_failed: "delivery_failed",
  },
  out_for_delivery: {
    out_for_delivery: "out_for_delivery",
    delivered: "delivered",
    delivery_failed: "delivery_failed",
  },
  // A failed delivery attempt is NOT terminal: a later courier re-attempt may
  // legitimately move the shipment forward again.
  delivery_failed: {
    in_transit: "in_transit",
    out_for_delivery: "out_for_delivery",
    delivered: "delivered",
    delivery_failed: "delivery_failed",
  },
  // Delivered is TERMINAL: nothing may move a delivered shipment backwards.
  delivered: {
    delivered: "delivered",
  },
};

export class CourierTrackingStateMachine {
  private constructor() {}

  /** A state from which no backward/progress regression is ever permitted. */
  static isTerminal(state: CourierTrackingState): boolean {
    return state === "delivered";
  }

  /**
   * Apply a tracking event with a domain guard. Same-state events return the
   * same state (idempotent). Throws INVALID_STATUS_TRANSITION when the event
   * is impossible from the current state (e.g. `delivered` -> `in_transit`).
   */
  static next(
    state: CourierTrackingState,
    event: CourierTrackingEvent,
  ): CourierTrackingState {
    const target = TRANSITIONS[state]?.[event];
    if (!target) {
      throw new DomainError(
        "INVALID_STATUS_TRANSITION",
        `Courier tracking transition ${state} -> ${event} is not permitted.`,
      );
    }
    return target;
  }
}