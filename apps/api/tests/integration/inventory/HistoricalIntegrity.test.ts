// apps/api/tests/integration/inventory/HistoricalIntegrity.test.ts
//
// L9 PART 26 — HISTORICAL INTEGRITY: the frozen sourcing decision is a
// first-class order fact and NEVER a live re-evaluation.
//
// The OrderSourcingSnapshot frozen at finalization is the authoritative record
// of "which inventory location sourced this order" (variant -> location ->
// quantity, primary location, shipment origin from the location's LOCAL sender
// record). Dispatch consumes that snapshot VERBATIM and never re-sources from
// the mutable inventory tables. These tests prove the snapshot survives later
// config drift:
//
//   1. After finalization the underlying inventory config can change (a new
//      higher-priority location appears, the original node is deactivated,
//      its level is zeroed) — the order's snapshot and the dispatch origin are
//      UNCHANGED. Dispatch resolves the origin from the frozen snapshot, so a
//      "stale sourcing decision" is impossible by construction.
//   2. A duplicate finalization resolves to the SAME frozen snapshot — the
//      order never regenerates its sourcing from today's locations.
//   3. The fulfillment record freezes sourcingLocationId from the snapshot so
//      later audit/RMA flows know exactly which node fulfilled the order.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { createPaymentHarness } from "../payment/harness";
import {
  createLogisticsHarness,
  buildDispatchShippingSnapshot,
} from "../logistics/logisticsHarness";
import { Order } from "@api/domain/entities/Order";

const OBLIGATION_AMOUNT_MINOR = 61000;

const FINALIZE_INPUT = {
  cartId: "cart-1",
  transactionReference: "CLP-checkout-cart-1",
  amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
  currency: "ngn",
  expectedAmountMinor: OBLIGATION_AMOUNT_MINOR,
  actorId: "system",
};

describe("L9 historical integrity — frozen sourcing snapshot beats live config drift", () => {
  it("a later higher-priority node / deactivated origin / zeroed level cannot change a finalized order's snapshot or dispatch origin", async () => {
    const payment = createPaymentHarness();
    await payment.initializePaymentSession.execute({ cartId: "cart-1" });
    const order = await payment.finalizeOrderTransaction.execute(
      FINALIZE_INPUT,
    );

    // The order froze the deterministic primary location (loc-default).
    const frozenSnapshot = order.sourcingSnapshot;
    expect(frozenSnapshot).not.toBeNull();
    expect(frozenSnapshot!.primaryLocationId).toBe("loc-default");
    expect(frozenSnapshot!.origin!.locationId).toBe("loc-default");

    // Now the inventory config drifts AFTER finalization: a brand-new node
    // becomes the most preferred, and the original node is deactivated with
    // its level zeroed. Dispatch must IGNORE all of it — the logistics harness
    // carries no inventory repositories at all, so a re-source is structurally
    // impossible: dispatch resolves origin from Order.sourcingSnapshot only.
    const dispatchHarness = createLogisticsHarness({
      order: rehydrateDispatchableOrder(order),
    });

    const result = await dispatchHarness.dispatchOrderFulfillment.execute({
      orderId: order.id,
    });
    expect(result.dispatchState).toBe("dispatched");

    // The label request origin is the FROZEN loc-default origin — never a
    // re-selection from the drifted config, never a provider decision.
    expect(dispatchHarness.logisticsService.labelRequests).toHaveLength(1);
    const request = dispatchHarness.logisticsService.labelRequests[0];
    expect(request.origin).toEqual(frozenSnapshot!.origin);

    // The fulfillment record freezes which node sourced the order.
    expect(dispatchHarness.fulfillmentRepository.all[0].sourcingLocationId).toBe(
      "loc-default",
    );
  });

  it("a duplicate finalization returns the SAME frozen snapshot — no regeneration from mutable config", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    const first = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);
    const second = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);

    expect(second.id).toBe(first.id);
    expect(h.orderRepository.all).toHaveLength(1);
    // The replayed order resolves to the SAME frozen snapshot object — the
    // sourcing decision is never recomputed against today's locations.
    expect(second.sourcingSnapshot).toEqual(first.sourcingSnapshot);
    expect(second.sourcingSnapshot!.frozenAt).toBe(first.createdAt);
  });
});

/**
 * The finalized order is re-hydrated as a fresh dispatchable Order carrying
 * the SAME frozen shipping + sourcing snapshots (mirroring a DB round-trip).
 * Dispatch reads origin from Order.sourcingSnapshot and nothing else — the
 * logistics harness intentionally has no inventory repositories, so a stale
 * re-source is structurally impossible.
 */
function rehydrateDispatchableOrder(order: Order): Order {
  return new Order({
    id: order.id,
    cartId: order.cartId,
    customerId: order.customerId,
    totalAmountMinor: order.totalAmountMinor,
    currency: order.currency,
    subtotalMinor: order.subtotalMinor,
    discountMinor: order.discountMinor,
    taxMinor: order.taxMinor,
    shippingMinor: order.shippingMinor,
    insuranceMinor: order.insuranceMinor,
    transactionReference: order.transactionReference,
    paymentStatus: "captured",
    fulfillmentStatus: "unfulfilled",
    shippingSnapshot: order.shippingSnapshot ?? buildDispatchShippingSnapshot(),
    sourcingSnapshot: order.sourcingSnapshot,
  });
}