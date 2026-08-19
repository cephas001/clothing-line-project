// apps/api/tests/integration/notifications/NotificationOutboxLifecycle.test.ts
//
// INTEGRATION TESTS — L8 notification intents are appended INSIDE the
// business transaction that produces them (never before commit, never after a
// provider call).
//
// Proves, through the real use cases and the in-memory fakes:
//   1. PAYMENT SUCCESS -> notification: finalizing a captured checkout appends
//      a `payment_confirmation` intent atomically with the captured order,
//      whose breakdown is the FROZEN durable obligation (never recomputed) and
//      whose recipient is the authoritative checkout email.
//   2. DISPATCH -> notification: a confirmed dispatch appends a
//      `shipment_dispatched` intent inside the same unit of work, recipient =
//      the FROZEN order shipping snapshot (never the provider response).
//   3. STALE TRACKING EVENTS never notify: a same-state replay leaves
//      `trackingChanged` false and cannot re-append; a real state change
//      appends exactly one intent with discriminator = eventKey.
//   4. REFUND -> notification: a dispatched swap refund appends a
//      `refund_issued` intent with discriminator = refundReference and the
//      frozen Refund.amountMinor; a replay never double-appends.
//   5. Duplicate appends collide on the deterministic (intentType, aggregateId,
//      discriminator) identity instead of double-sending.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import {
  createPaymentHarness,
} from "../payment/harness";
import {
  createLogisticsHarness,
  buildLogisticsEvent,
  buildDispatchableOrder,
} from "../logistics/logisticsHarness";
import {
  createSwapHarness,
  seedReplacementPrice,
  REPLACEMENT_VARIANT_ID,
} from "../logistics/swapHarness";
import { RepositoryErrorCode } from "@api/domain/interfaces/shared/errors/RepositoryError";
import { notificationAggregateId } from "@api/domain/shared/notifications";

const OBLIGATION_AMOUNT_MINOR = 61000;

const FINALIZE_INPUT = {
  cartId: "cart-1",
  transactionReference: "CLP-checkout-cart-1",
  amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
  currency: "ngn",
  expectedAmountMinor: OBLIGATION_AMOUNT_MINOR,
  actorId: "system",
};

describe("Payment success -> payment_confirmation intent (frozen values)", () => {
  it("appends ONE payment_confirmation intent inside the finalize transaction", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });
    await h.verifyPaymentEvent.execute({
      cartId: "cart-1",
      transactionReference: "CLP-checkout-cart-1",
      amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
      reportedCurrency: "ngn",
    });

    const order = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);

    const rows = h.notificationOutboxRepository.rows;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.intentType).toBe("payment_confirmation");
    expect(row.aggregateId).toBe(order.id);
    expect(notificationAggregateId(row.payload)).toBe(order.id);
    expect(row.discriminator).toBeNull();

    if (row.payload.type === "payment_confirmation") {
      // RECIPIENT is the authoritative checkout email frozen on the cart.
      expect(row.payload.payload.recipient.email).toBe("buyer@example.com");
      // FINANCIAL: the breakdown is the FROZEN durable obligation — the exact
      // server-computed values the gateway captured, never recomputed here.
      expect(row.payload.payload.breakdown).toEqual({
        subtotalMinor: 60000,
        discountMinor: 5000,
        taxMinor: 3000,
        shippingMinor: 2500,
        insuranceMinor: 500,
        totalMinor: OBLIGATION_AMOUNT_MINOR,
      });
      expect(row.payload.payload.order.currency).toBe("ngn");
      expect(row.payload.payload.transactionReference).toBe("CLP-checkout-cart-1");
    }
  });

  it("is idempotent on replay: a duplicate finalization never appends a second intent", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });
    await h.verifyPaymentEvent.execute({
      cartId: "cart-1",
      transactionReference: "CLP-checkout-cart-1",
      amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
      reportedCurrency: "ngn",
    });

    const first = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);
    const replay = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);

    // The replay resolves to the SAME durable order (idempotent finalization),
    // so exactly ONE payment_confirmation intent exists.
    expect(replay.id).toBe(first.id);
    expect(h.orderRepository.all).toHaveLength(1);
    expect(h.notificationOutboxRepository.rows).toHaveLength(1);
  });

  it("finalizes with NO intent when the cart has no email (best-effort, never blocked)", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });
    await h.verifyPaymentEvent.execute({
      cartId: "cart-1",
      transactionReference: "CLP-checkout-cart-1",
      amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
      reportedCurrency: "ngn",
    });
    // The checkout email is authoritative; a checkout with NO contact email
    // still finalizes (the order is real) but cannot append a notification.
    h.cart.email = null;

    const order = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);
    expect(order.id).toBeDefined();
    expect(h.orderRepository.all).toHaveLength(1);
    expect(h.notificationOutboxRepository.rows).toHaveLength(0);
  });
});

describe("Dispatch success -> shipment_dispatched intent (frozen snapshot)", () => {
  it("appends a shipment_dispatched intent inside the dispatch transaction", async () => {
    const h = createLogisticsHarness();

    const result = await h.dispatchOrderFulfillment.execute({ orderId: "order-1" });
    expect(result.dispatchState).toBe("dispatched");

    const rows = h.notificationOutboxRepository.rows;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.intentType).toBe("shipment_dispatched");
    expect(row.aggregateId).toBe(result.fulfillmentId);
    expect(row.discriminator).toBeNull();

    if (row.payload.type === "shipment_dispatched") {
      // RECIPIENT comes from the FROZEN checkout snapshot — never the provider.
      expect(row.payload.payload.recipient.email).toBe("buyer@example.com");
      expect(row.payload.payload.recipient.name).toBe("Ada Okafor");
      // Provider identity is first-class, not the application order id.
      expect(row.payload.payload.providerShipmentId).toBe("SB-ORDER-1");
      expect(row.payload.payload.trackingNumber).toBe("TRK-ORDER-1");
      expect(row.payload.payload.order.orderId).toBe("order-1");
    }
  });

  it("never re-appends on a replayed dispatch (duplicate provider evidence)", async () => {
    // An existing provider shipment id is replayed (resolveConcurrentClaim) —
    // the create path that appends the intent never runs, so the intent
    // cannot be double-appended by a concurrent/raced dispatch.
    const existing = {
      id: "f-1",
      orderId: "order-1",
      trackingNumber: "TRK-ORDER-1",
      providerShipmentId: "SB-ORDER-1",
      status: "dispatched",
      courier: "DHL",
    };
    const h = createLogisticsHarness({
      order: buildDispatchableOrder({
        fulfillmentStatus: "unfulfilled",
        fulfillments: [existing],
      }),
    });
    h.fulfillmentRepository.seed(existing);

    const replay = await h.dispatchOrderFulfillment.execute({ orderId: "order-1" });
    expect(replay.replayed).toBe(true);

    // Zero POSTs, zero intents — a replay is not a new dispatch.
    expect(h.logisticsService.labelRequests).toHaveLength(0);
    expect(
      h.notificationOutboxRepository.rows.filter(
        (r) => r.intentType === "shipment_dispatched",
      ),
    ).toHaveLength(0);
  });
});

describe("Courier tracking events -> tracking_update intents (stale-safe)", () => {
  function seedDispatched(
    h: ReturnType<typeof createLogisticsHarness>,
    tracking?: { status: string; updatedAt: string; eventKey: string },
  ): void {
    h.fulfillmentRepository.seed({
      id: "f-1",
      orderId: "order-1",
      trackingNumber: "TRK-1",
      providerShipmentId: "SB-123",
      status: "dispatched",
      courier: "DHL",
      metadata: tracking ? { tracking } : undefined,
    });
  }

  it("appends a tracking_update intent ONLY on a real state change, keyed by eventKey", async () => {
    const h = createLogisticsHarness();
    seedDispatched(h);

    const result = await h.processCourierTrackingEvent.execute({
      logisticsEvent: buildLogisticsEvent({
        eventKey: "shipbubble:evt-1",
        eventType: "tracking.status_changed",
        status: "in_transit",
        occurredAt: "2026-08-15T10:00:00Z",
      }),
    });
    expect(result.changed).toBe(true);
    expect(result.trackingState).toBe("in_transit");

    const rows = h.notificationOutboxRepository.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].intentType).toBe("tracking_update");
    expect(rows[0].discriminator).toBe("shipbubble:evt-1");
    if (rows[0].payload.type === "tracking_update") {
      expect(rows[0].payload.payload.status).toBe("in_transit");
      expect(rows[0].payload.payload.recipient.email).toBe("buyer@example.com");
    }
  });

  it("a SAME-STATE replay (stale event) changes nothing and never re-notifies", async () => {
    const h = createLogisticsHarness();
    seedDispatched(h);

    const first = await h.processCourierTrackingEvent.execute({
      logisticsEvent: buildLogisticsEvent({
        eventKey: "shipbubble:evt-1",
        eventType: "tracking.status_changed",
        status: "in_transit",
        occurredAt: "2026-08-15T10:00:00Z",
      }),
    });
    expect(first.outcome).toBe("processed");

    const replay = await h.processCourierTrackingEvent.execute({
      logisticsEvent: buildLogisticsEvent({
        eventKey: "shipbubble:evt-1",
        eventType: "tracking.status_changed",
        status: "in_transit",
        occurredAt: "2026-08-15T10:00:00Z",
      }),
    });
    expect(replay.outcome).toBe("ignored_stale");
    expect(replay.changed).toBe(false);

    // Still exactly ONE intent — a stale event cannot double-notify.
    expect(h.notificationOutboxRepository.rows).toHaveLength(1);
  });

  it("a terminal delivered event appends once and an identical replay does not re-notify", async () => {
    const h = createLogisticsHarness();
    seedDispatched(h);

    await h.processCourierTrackingEvent.execute({
      logisticsEvent: buildLogisticsEvent({
        eventKey: "shipbubble:evt-dlv-1",
        eventType: "delivery.completed",
        status: "delivered",
        occurredAt: "2026-08-15T12:00:00Z",
      }),
    });
    const replay = await h.processCourierTrackingEvent.execute({
      logisticsEvent: buildLogisticsEvent({
        eventKey: "shipbubble:evt-dlv-1",
        eventType: "delivery.completed",
        status: "delivered",
        occurredAt: "2026-08-15T12:00:00Z",
      }),
    });
    expect(replay.outcome).toBe("ignored_stale");

    const trackingRows = h.notificationOutboxRepository.rows.filter(
      (r) => r.intentType === "tracking_update",
    );
    expect(trackingRows).toHaveLength(1);
    if (trackingRows[0].payload.type === "tracking_update") {
      expect(trackingRows[0].payload.payload.status).toBe("delivered");
    }
  });
});

describe("Swap refund -> refund_issued intent (frozen Refund record)", () => {
  const SWAP_INPUT = {
    orderId: "order-1",
    returnLineItemId: "line-1",
    returnQuantity: 1,
    newVariantId: REPLACEMENT_VARIANT_ID,
    actorId: "customer-1",
  };

  it("appends a refund_issued intent with discriminator = refundReference and the frozen amount", async () => {
    const h = createSwapHarness();
    seedReplacementPrice(h, 20000); // new value 20000 vs original 25000 -> refund 5000

    const result = await h.processOrderSwapVariance.execute(SWAP_INPUT);
    expect(result.action).toBe("REFUND_DISPATCHED");

    const rows = h.notificationOutboxRepository.rows;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.intentType).toBe("refund_issued");
    expect(row.discriminator).toBeTruthy();
    if (row.payload.type === "refund_issued") {
      expect(row.payload.payload.recipient.email).toBe("buyer@example.com");
      // FROZEN amount from the durable Refund record, with the order currency.
      expect(row.payload.payload.money.amountMinor).toBe(5000);
      expect(row.payload.payload.money.currency).toBe("ngn");
      expect(row.payload.payload.refundReference).toBe(row.discriminator!);
    }
  });

  it("a refund replay resolves idempotently and never double-appends", async () => {
    const h = createSwapHarness();
    seedReplacementPrice(h, 20000);

    const first = await h.processOrderSwapVariance.execute(SWAP_INPUT);
    expect(first.action).toBe("REFUND_DISPATCHED");

    const replay = await h.processOrderSwapVariance.execute(SWAP_INPUT);
    expect(replay.action).toBe("REFUND_DISPATCHED");

    expect(
      h.notificationOutboxRepository.rows.filter(
        (r) => r.intentType === "refund_issued",
      ),
    ).toHaveLength(1);
  });
});

describe("Outbox identity — duplicate appends collide instead of double-sending", () => {
  it("the same (intentType, aggregateId, discriminator) append surfaces DUPLICATE", async () => {
    const h = createLogisticsHarness();
    await h.dispatchOrderFulfillment.execute({ orderId: "order-1" });

    // Re-append the SAME logical shipment_dispatched intent manually — the
    // repository enforces the unique identity the migration 0014 mirror guards.
    const existing = h.notificationOutboxRepository.rows[0];
    try {
      await h.notificationOutboxRepository.append("dup-id", existing.payload);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as { code?: string }).code).toBe(RepositoryErrorCode.DUPLICATE);
    }
  });
});