// apps/storefront/src/lib/checkoutGate.ts
//
// F9 / E3 — pure checkout ENTRY decisions.
//
// Which full-screen state CheckoutView renders, decided entirely here so the
// component cannot reorder the precedence by accident. The precedence mirrors
// the established view exactly (F6 Slice 6):
//
//   1. cart-loading     the cart session is still resolving — nothing claimed.
//   2. cart-error       the cart could not be loaded — recoverable via retry,
//                       never rendered as an empty cart.
//   3. gateway-return   a ?reference= return is being verified — takes over
//                       the page even though a converted cart may have ZERO
//                       lines (session recovery swapped it).
//   4. empty-cart       honestly empty.
//   5. actionable       the normal checkout flow.
//
// The payment/cart guarantees are unchanged: an amount is never computed, a
// payment never initialized without a SERVER-FROZEN shipping selection plus a
// saved address, and no gate ever fakes readiness.

import type { GatewayReturnState } from "./paymentReturn";

/** Mirrors CartContext's status union (structural, keeps this module pure). */
export type CheckoutCartStatus = "loading" | "ready" | "error";

export type CheckoutGate =
  | { kind: "cart-loading" }
  | { kind: "cart-error"; message: string | null }
  | { kind: "gateway-return" }
  | { kind: "empty-cart" }
  | { kind: "actionable" };

/** Resolve the full-screen gate for /checkout. Pure precedence, no fetching. */
export function resolveCheckoutViewGate(input: {
  cartStatus: CheckoutCartStatus;
  lineCount: number;
  gatewayReturnState: GatewayReturnState;
}): CheckoutGate {
  if (input.cartStatus === "loading") return { kind: "cart-loading" };
  if (input.cartStatus === "error") return { kind: "cart-error", message: null };
  if (input.gatewayReturnState !== "idle") return { kind: "gateway-return" };
  if (input.lineCount === 0) return { kind: "empty-cart" };
  return { kind: "actionable" };
}

export interface PlaceOrderReadiness {
  /** True only when every server-backed precondition holds. */
  canPlaceOrder: boolean;
  /**
   * Why the button is disabled — null when ready. Honest guidance, never a
   * fake enabled state.
   */
  reason: string | null;
}

/**
 * Payment-entry readiness. Requires BOTH facts the backend froze/verified:
 * the saved shipping address (tax was recalculated server-side) and a selected
 * shipping option (the amount was frozen server-side). Never ready while a
 * sync or payment initialization is in flight.
 */
export function placeOrderReadiness(input: {
  addressSaved: boolean;
  shippingSelected: boolean;
  syncing: boolean;
  initializingPayment: boolean;
}): PlaceOrderReadiness {
  if (input.initializingPayment) {
    return { canPlaceOrder: false, reason: null };
  }
  if (!input.addressSaved && !input.shippingSelected) {
    return {
      canPlaceOrder: false,
      reason: "Save your address, then pick a shipping option to continue.",
    };
  }
  if (!input.addressSaved) {
    return { canPlaceOrder: false, reason: "Save your address to continue." };
  }
  if (!input.shippingSelected) {
    return {
      canPlaceOrder: false,
      reason: "Pick a shipping option to continue.",
    };
  }
  if (input.syncing) {
    return { canPlaceOrder: false, reason: null };
  }
  return { canPlaceOrder: true, reason: null };
}
