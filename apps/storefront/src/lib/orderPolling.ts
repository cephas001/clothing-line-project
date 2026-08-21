// apps/storefront/src/lib/orderPolling.ts
//
// G008 — order-detail refresh strategy (pure rules, no React, no HTTP, no
// global polling framework: the only consumer is the order-detail view, which
// owns a single local interval).
//
// The public Order projection carries mutable state (fulfillment/tracking
// progress). While that state is still mutable the view refreshes it on a
// slow local interval; once it reaches a TERMINAL fulfillment state nothing
// more can change and polling stops for good.
//
// Terminality is judged ONLY from server-authoritative enum values:
//   - fulfilled  — everything shipped; lifecycle complete
//   - returned   — lifecycle complete after a return
// `on_hold` is deliberately NOT terminal (it can resume), and payment states
// are deliberately ignored (a captured payment still precedes shipping
// activity worth refreshing).

import type { Order } from "@clothing-line-project/shared-types";

/** Slow, polite refresh cadence for an open order-detail page. */
export const ORDER_POLL_INTERVAL_MS = 15_000;

/** A terminal fulfillment state can never change again. */
export function isOrderSettled(
  order: Pick<Order, "fulfillmentStatus">,
): boolean {
  return (
    order.fulfillmentStatus === "fulfilled" ||
    order.fulfillmentStatus === "returned"
  );
}

/** Whether an open order-detail page should keep refreshing this projection. */
export function shouldPollOrder(order: Order | null): boolean {
  return order !== null && !isOrderSettled(order);
}
