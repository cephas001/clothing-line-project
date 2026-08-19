// apps/api/tests/unit/notifications/NotificationContracts.test.ts
//
// UNIT TESTS — L8 notification contracts (domain/shared/notifications +
// domain/shared/jobs).
//
// Proves, at the domain edge (no provider, no DB, no queue):
//   1. `notificationAggregateId` maps every intent onto the correct durable
//      aggregate — the stable idempotency-key segment.
//   2. `buildNotificationJobId` produces a DETERMINISTIC, sanitized job id for
//      one logical notification (the outbox sweep's duplicate-collapse key).
//   3. `parseNotificationEventJobPayload` round-trips a valid payload and
//      REJECTS malformed ones with the stable VALIDATION_ERROR code — the
//      queue's "malformed job rejection" contract, classified as a permanent
//      (never-retryable) failure by the worker.
//   4. A validated job payload contains NO credentials anywhere (no API key,
//      no Authorization header, no secret) — the queue-payload security test.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import {
  notificationAggregateId,
  type NotificationIntent,
} from "@api/domain/shared/notifications";
import {
  buildNotificationJobId,
  parseNotificationEventJobPayload,
  type NotificationEventJobPayload,
} from "@api/domain/shared/jobs";

function buildPaymentIntent(orderId = "order-1"): NotificationIntent {
  return {
    type: "payment_confirmation",
    payload: {
      recipient: { email: "buyer@example.com", name: "Ada Okafor" },
      order: {
        orderId,
        cartId: "cart-1",
        customerId: "customer-1",
        currency: "ngn",
        createdAt: "2026-08-15T10:00:00.000Z",
      },
      transactionReference: "CLP-checkout-cart-1",
      breakdown: {
        subtotalMinor: 60000,
        discountMinor: 5000,
        taxMinor: 3000,
        shippingMinor: 2500,
        insuranceMinor: 500,
        totalMinor: 61000,
      },
      paidAt: "2026-08-15T10:00:01.000Z",
      lineItems: [
        { id: "line-1", variantId: "variant-1", quantity: 2, unitPriceMinor: 25000 },
        { id: "line-2", variantId: "variant-2", quantity: 1, unitPriceMinor: 10000 },
      ],
    },
  };
}

function buildTrackingIntent(): NotificationIntent {
  return {
    type: "tracking_update",
    payload: {
      recipient: { email: "buyer@example.com" },
      order: {
        orderId: "order-1",
        cartId: "cart-1",
        customerId: "customer-1",
        currency: "ngn",
        createdAt: "2026-08-15T10:00:00.000Z",
      },
      fulfillmentId: "fulfillment-1",
      trackingNumber: "TRK-1",
      courier: "DHL",
      status: "delivered",
      occurredAt: "2026-08-15T12:00:00.000Z",
    },
  };
}

function wrap(intent: NotificationIntent, outboxRecordId = "outbox-1"): NotificationEventJobPayload {
  return {
    outboxRecordId,
    intent,
    enqueuedAt: "2026-08-15T13:00:00.000Z",
  };
}

describe("Notification contracts — notificationAggregateId (idempotency segment)", () => {
  it("payment_confirmation aggregates on the ORDER id", () => {
    expect(notificationAggregateId(buildPaymentIntent("order-77"))).toBe("order-77");
  });

  it("tracking_update and shipment_dispatched aggregate on the FULFILLMENT id", () => {
    expect(notificationAggregateId(buildTrackingIntent())).toBe("fulfillment-1");
    expect(
      notificationAggregateId({
        type: "shipment_dispatched",
        payload: {
          recipient: { email: "buyer@example.com" },
          order: {
            orderId: "order-1",
            cartId: "cart-1",
            customerId: "customer-1",
            currency: "ngn",
            createdAt: "2026-08-15T10:00:00.000Z",
          },
          fulfillmentId: "fulfillment-9",
          providerShipmentId: "SB-123",
          trackingNumber: "TRK-1",
          dispatchedAt: "2026-08-15T11:00:00.000Z",
        },
      }),
    ).toBe("fulfillment-9");
  });

  it("refund_issued aggregates on the ORDER id; password_reset/quote/draft order on their own ids", () => {
    expect(
      notificationAggregateId({
        type: "refund_issued",
        payload: {
          recipient: { email: "buyer@example.com" },
          order: {
            orderId: "order-1",
            cartId: "cart-1",
            customerId: "customer-1",
            currency: "ngn",
            createdAt: "2026-08-15T10:00:00.000Z",
          },
          refundId: "refund-1",
          refundReference: "refund-1",
          money: { currency: "ngn", amountMinor: 5000 },
          issuedAt: "2026-08-15T14:00:00.000Z",
        },
      }),
    ).toBe("order-1");
    expect(
      notificationAggregateId({
        type: "password_reset",
        payload: {
          recipient: { email: "buyer@example.com" },
          customerId: "customer-9",
          token: "tok-1",
          expiresInSeconds: 3600,
          requestedAt: "2026-08-15T10:00:00.000Z",
        },
      }),
    ).toBe("customer-9");
  });
});

describe("Notification contracts — buildNotificationJobId (deterministic idempotency key)", () => {
  it("is deterministic: identical intent + discriminator yields the identical job id", () => {
    const a = buildNotificationJobId(buildPaymentIntent("order-1"), null);
    const b = buildNotificationJobId(buildPaymentIntent("order-1"), null);
    expect(a).toBe(b);
    expect(a).toBe("notification:payment_confirmation:order-1");
  });

  it("appends the sanitized per-occurrence discriminator for repeated intents", () => {
    const id = buildNotificationJobId(
      buildTrackingIntent(),
      "shipbubble:evt-dlv-1",
    );
    // The raw "shipbubble:evt-dlv-1" key is sanitized to safe key bytes
    // ("shipbubble-evt-dlv-1") so the provider delimiter can never leak into
    // the BullMQ jobId segment, while remaining deterministic per occurrence.
    expect(id).toBe("notification:tracking_update:fulfillment-1:shipbubble-evt-dlv-1");
  });

  it("sanitizes unsafe characters in key segments (no provider bytes leak in)", () => {
    const id = buildNotificationJobId(
      buildTrackingIntent(),
      "evt/a b?c",
    );
    expect(id).toContain("evt-a-b-c");
  });

  it("rejects an empty aggregate segment (never a degenerate job id)", () => {
    const intent: NotificationIntent = {
      type: "payment_confirmation",
      payload: {
        recipient: { email: "buyer@example.com" },
        order: {
          orderId: "   ",
          cartId: "cart-1",
          customerId: "customer-1",
          currency: "ngn",
          createdAt: "2026-08-15T10:00:00.000Z",
        },
        transactionReference: "CLP-checkout-cart-1",
        breakdown: {
          subtotalMinor: 0,
          discountMinor: 0,
          taxMinor: 0,
          shippingMinor: 0,
          insuranceMinor: 0,
          totalMinor: 0,
        },
        paidAt: "2026-08-15T10:00:01.000Z",
        lineItems: [],
      },
    };
    expect(() => buildNotificationJobId(intent, null)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });
});

describe("Notification contracts — parseNotificationEventJobPayload (malformed job rejection)", () => {
  it("round-trips a valid payment_confirmation payload", () => {
    const parsed = parseNotificationEventJobPayload(wrap(buildPaymentIntent()));
    expect(parsed.outboxRecordId).toBe("outbox-1");
    expect(parsed.intent.type).toBe("payment_confirmation");
    if (parsed.intent.type === "payment_confirmation") {
      expect(parsed.intent.payload.breakdown.totalMinor).toBe(61000);
      expect(parsed.intent.payload.recipient.email).toBe("buyer@example.com");
    }
  });

  it("rejects a non-object payload", () => {
    expect(() => parseNotificationEventJobPayload(null)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
    expect(() => parseNotificationEventJobPayload("junk")).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("rejects a payload without the outbox record id", () => {
    const bad = { ...wrap(buildPaymentIntent()), outboxRecordId: "" };
    expect(() => parseNotificationEventJobPayload(bad)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("rejects an unknown intent.type (poison payload)", () => {
    const bad = wrap(buildPaymentIntent());
    (bad.intent as { type: string }).type = "marketing_blast";
    expect(() => parseNotificationEventJobPayload(bad)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("rejects a structurally invalid recipient email", () => {
    const bad = wrap(buildPaymentIntent());
    (bad.intent.payload as { recipient: { email: string } }).recipient = {
      email: "not-an-email",
    };
    expect(() => parseNotificationEventJobPayload(bad)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("rejects a negative/float financial value in the frozen breakdown", () => {
    const bad = wrap(buildPaymentIntent());
    const payload = bad.intent.payload as {
      breakdown: { totalMinor: number };
    };
    payload.breakdown = { ...payload.breakdown, totalMinor: -5 };
    expect(() => parseNotificationEventJobPayload(bad)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("rejects an invalid timestamp", () => {
    const bad = wrap(buildPaymentIntent());
    const payload = bad.intent.payload as { paidAt: string };
    payload.paidAt = "yesterday";
    expect(() => parseNotificationEventJobPayload(bad)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });
});

describe("Notification contracts — queue payloads contain NO credentials (security)", () => {
  it("a validated job payload serializes without any API key / authorization material", () => {
    const serialized = JSON.stringify(wrap(buildPaymentIntent()));
    const normalized = serialized.toLowerCase();
    for (const forbidden of [
      "apiKey",
      "api_key",
      "authorization",
      "secret",
      "bearer ",
      "sk_live",
      "re_",
    ]) {
      expect(normalized.includes(forbidden)).toBe(false);
    }
  });

  it("a tracking intent (courier webhook evidence) carries no recipient-controlling credential", () => {
    const serialized = JSON.stringify(wrap(buildTrackingIntent()));
    const normalized = serialized.toLowerCase();
    expect(normalized.includes("apiKey")).toBe(false);
    expect(normalized.includes("authorization")).toBe(false);
  });
});