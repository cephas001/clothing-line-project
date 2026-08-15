// apps/api/src/domain/shared/dispatchStateMachine.ts

// Explicit lifecycle of an order's fulfillment DISPATCH.
//
// DispatchOrderFulfillmentUseCase drives a fulfillment record through this
// state machine so the system can always distinguish — durably, with guards —
// between:
//   - `not_attempted`          — no dispatch attempt has been made (no row);
//   - `dispatch_pending`       — a create attempt is IN PROGRESS: the record
//                                was durably claimed before the provider POST,
//                                so a crash between claim and POST leaves a
//                                provable attempt whose outcome is unknown;
//   - `dispatched`             — definite success: provider shipment id +
//                                tracking number persisted durably;
//   - `requires_reconciliation`— ambiguous outcome (timeout/network/5xx, or a
//                                created-but-unconfirmable shipment, or a
//                                persistence failure after the provider created
//                                the shipment): the provider MAY hold a
//                                shipment, so another create POST must never be
//                                issued automatically;
//   - `failed`                 — terminally failed: the provider DEFINITIVELY
//                                rejected the create; no shipment exists.
//
// Terminal states (`dispatched`, `requires_reconciliation`, `failed`) never
// allow another automatic create attempt.
//
// `confirmed_by_tracking` is the ONLY webhook-driven exit from the terminal
// `requires_reconciliation` state: when a logistics webhook carries AUTHORITATIVE
// provider evidence that the shipment exists (a courier tracking event, or a
// shipment.created event), the reconciliation is resolved and the dispatch is
// durably advanced to `dispatched`. It is only ever applied when the state
// machine permits it — never by arbitrary assignment, and it NEVER initiates
// another create request.

import { DomainError } from "@api/domain/entities/errors/DomainError";

/** Lifecycle state of an order's fulfillment dispatch (see module doc). */
export type DispatchState =
  | "not_attempted"
  | "dispatch_pending"
  | "dispatched"
  | "requires_reconciliation"
  | "failed";

/** Lifecycle events the dispatch use case applies to a fulfillment record. */
export type DispatchEvent =
  | "attempt_started"
  | "confirmed"
  | "ambiguous"
  | "rejected"
  | "confirmed_by_tracking";

const TRANSITIONS: Record<
  DispatchState,
  Partial<Record<DispatchEvent, DispatchState>>
> = {
  not_attempted: { attempt_started: "dispatch_pending" },
  dispatch_pending: {
    confirmed: "dispatched",
    ambiguous: "requires_reconciliation",
    rejected: "failed",
  },
  dispatched: {},
  requires_reconciliation: { confirmed_by_tracking: "dispatched" },
  failed: {},
};

export class DispatchStateMachine {
  private constructor() {}

  /** A state from which no further automatic provider attempt may originate. */
  static isTerminal(state: DispatchState): boolean {
    return (
      state === "dispatched" ||
      state === "requires_reconciliation" ||
      state === "failed"
    );
  }

  /** True only when a fresh create attempt may be started from this state. */
  static mayStartAttempt(state: DispatchState): boolean {
    return state === "not_attempted";
  }

  /**
   * Apply a lifecycle event with a domain guard. Throws INVALID_STATE when the
   * transition is not permitted (e.g. starting a new attempt from a terminal
   * state).
   */
  static next(state: DispatchState, event: DispatchEvent): DispatchState {
    const target = TRANSITIONS[state]?.[event];
    if (!target) {
      throw new DomainError(
        "INVALID_STATE",
        `Dispatch transition ${state} -> ${event} is not permitted.`,
      );
    }
    return target;
  }
}
