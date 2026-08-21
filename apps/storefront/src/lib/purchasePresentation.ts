// apps/storefront/src/lib/purchasePresentation.ts
//
// F9 / E4 — pure purchase/payment presentation decisions.
//
// Maps a GatewayReturnState (from lib/paymentReturn.ts — the ONLY source of
// payment truth) onto the words and affordances the checkout return view may
// render. This module NEVER infers success: `receiptAvailable` is true only
// for the "confirmed" state AND a server-issued order id. A timeout that
// happens to carry an id, or any client-side guess, can never produce an
// order link, and "not_confirmed" is never softened into "still verifying".

import type { GatewayReturnState } from "./paymentReturn";

export type PurchaseRecoveryAction =
  | "none"
  | "check-again"
  | "restart-checkout";

export interface PurchasePresentation {
  /** Small bracketed status badge above the headline. */
  badge: string;
  /** The big display headline. */
  headline: string;
  /** Explanatory body copy (truthful about what IS and ISN'T known). */
  body: string;
  /**
   * Whether the persistent order link may render — ONLY a server-confirmed
   * purchase with a server-issued order id.
   */
  receiptAvailable: boolean;
  /** The recovery affordance to offer, if any. */
  recoveryAction: PurchaseRecoveryAction;
}

/**
 * Present a gateway return state. Pure — every input is either the classifier
 * output or a server-issued value (reference from the URL, orderId from a
 * server projection / validated persisted receipt).
 */
export function presentPurchaseState(input: {
  state: GatewayReturnState;
  reference: string | null;
  orderId: string | null;
}): PurchasePresentation {
  const reference = input.reference?.trim() || null;
  const orderId = input.orderId?.trim() || null;

  switch (input.state) {
    case "confirmed": {
      const where = reference
        ? `Reference ${reference} — we\u2019re on it. Check your email for order details.`
        : orderId
          ? `Your order is confirmed. Check your email for order details.`
          : `Payment confirmed. Check your email for order details.`;
      return {
        badge: "[ PAYMENT CONFIRMED ]",
        headline: "THANK YOU.",
        body: where,
        receiptAvailable: orderId !== null,
        recoveryAction: "none",
      };
    }
    case "timeout":
      return {
        badge: "[ NOT CONFIRMED YET ]",
        headline: "WE HAVEN'T RECEIVED YOUR PAYMENT CONFIRMATION.",
        body: "The store confirms payments through the gateway, and it's taking longer than expected. This is not a success or a failure — no order has been created yet. If you completed the payment, checking again should find it.",
        receiptAvailable: false,
        recoveryAction: "check-again",
      };
    case "not_confirmed":
      return {
        badge: "[ NO CONFIRMED PAYMENT ]",
        headline: "WE COULDN'T CONFIRM YOUR PAYMENT.",
        body: `There is no completed payment recorded for this checkout${reference ? ` (reference ${reference})` : ""}. Nothing has been confirmed as paid. You can start the payment again from the beginning.`,
        receiptAvailable: false,
        recoveryAction: "restart-checkout",
      };
    case "verifying":
      return {
        badge: "[ PROCESSING ]",
        headline: "PROCESSING PAYMENT…",
        body: "Please wait while we confirm your payment with the gateway.",
        receiptAvailable: false,
        recoveryAction: "none",
      };
    case "idle":
      return {
        badge: "",
        headline: "",
        body: "",
        receiptAvailable: false,
        recoveryAction: "none",
      };
  }
}
