// apps/api/tests/integration/notifications/NotificationPreferenceSuppression.test.ts
//
// INTEGRATION TESTS — L8-R PART 13: notification-preference suppression.
//
// Verified properties:
//   1. The default policy NEVER suppresses — every intent today is
//      transactional/legal, and an opt-out may never skip a payment
//      confirmation, dispatch, tracking update, refund, password reset, quote
//      approval, or draft-order invoice.
//   2. When a (future) policy DOES suppress, the suppression happens INSIDE the
//      adapter BEFORE any provider invocation: zero Resend calls.
//   3. A suppressed send produces a NULL provider receipt and does NOT mutate
//      the business intent it was handed (preference suppression never touches
//      business state).
//   4. The null receipt is a TERMINAL durable outcome on the outbox row: the
//      sweep never re-enqueues it and no guarded state transition can
//      resurrect it — there is NO retry loop.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import {
  DefaultNotificationPreferencePolicy,
  classifyNotification,
} from "@api/infrastructure/services/notifications/NotificationPreference";
import { ResendNotificationService } from "@api/infrastructure/services/ResendNotificationService";
import { InMemoryNotificationOutboxRepository } from "../../fakes/InMemoryNotificationOutboxRepository";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { FakeQueueService } from "../../fakes/FakeQueueService";
import { NoopLogger } from "../../fakes/NoopLogger";
import { EnqueuePendingNotificationsUseCase } from "@api/use-cases/notifications/EnqueuePendingNotificationsUseCase";
import type {
  NotificationIntent,
  NotificationDispatchResult,
  PaymentConfirmationNotification,
  TrackingUpdateNotification,
  ShipmentDispatchedNotification,
  RefundIssuedNotification,
  PasswordResetNotification,
  QuoteApprovedNotification,
  DraftOrderInvoiceNotification,
} from "@api/domain/shared/notifications";

const ORDER_CTX = {
  orderId: "order-1",
  cartId: "cart-1",
  customerId: "customer-1",
  currency: "ngn",
  createdAt: "2026-08-15T10:00:00.000Z",
};

function everyIntent(): Array<{ type: NotificationIntent["type"]; intent: NotificationIntent }> {
  const payment: PaymentConfirmationNotification = {
    recipient: { email: "buyer@example.com", name: "Ada Okafor" },
    order: ORDER_CTX,
    transactionReference: "ref-1",
    breakdown: {
      subtotalMinor: 60000,
      discountMinor: 5000,
      taxMinor: 3000,
      shippingMinor: 2500,
      insuranceMinor: 500,
      totalMinor: 61000,
    },
    paidAt: "2026-08-15T10:00:01.000Z",
    lineItems: [],
  };
  const shipment: ShipmentDispatchedNotification = {
    recipient: { email: "buyer@example.com", name: "Ada Okafor" },
    order: ORDER_CTX,
    fulfillmentId: "fulfillment-1",
    providerShipmentId: "shp_123",
    trackingNumber: "1Z999",
    dispatchedAt: "2026-08-15T10:00:02.000Z",
  };
  const tracking: TrackingUpdateNotification = {
    recipient: { email: "buyer@example.com", name: "Ada Okafor" },
    order: ORDER_CTX,
    fulfillmentId: "fulfillment-1",
    trackingNumber: "1Z999",
    status: "in_transit",
    occurredAt: "2026-08-15T10:00:03.000Z",
  };
  const refund: RefundIssuedNotification = {
    recipient: { email: "buyer@example.com", name: "Ada Okafor" },
    order: ORDER_CTX,
    refundId: "refund-1",
    refundReference: "CLP-refund-order-1",
    money: { currency: "ngn", amountMinor: 61000 },
    issuedAt: "2026-08-15T10:00:04.000Z",
  };
  const passwordReset: PasswordResetNotification = {
    recipient: { email: "buyer@example.com", name: "Ada Okafor" },
    customerId: "customer-1",
    token: "raw-token",
    expiresInSeconds: 3600,
    requestedAt: "2026-08-15T10:00:05.000Z",
  };
  const quote: QuoteApprovedNotification = {
    recipient: { email: "ada@example.com", name: "Ada Okafor" },
    quoteId: "quote-1",
    businessUnitId: "bu-1",
    approvedTotalMinor: 61000,
    approvedBy: "admin-1",
    approvedAt: "2026-08-15T10:00:06.000Z",
  };
  const draftInvoice: DraftOrderInvoiceNotification = {
    recipient: { email: "buyer@example.com" },
    draftOrderId: "draft-1",
    totalMinor: 38000,
    currency: null,
    itemCount: 2,
    createdAt: "2026-08-15T10:00:07.000Z",
  };
  return [
    { type: "payment_confirmation", intent: { type: "payment_confirmation", payload: payment } },
    { type: "shipment_dispatched", intent: { type: "shipment_dispatched", payload: shipment } },
    { type: "tracking_update", intent: { type: "tracking_update", payload: tracking } },
    { type: "refund_issued", intent: { type: "refund_issued", payload: refund } },
    { type: "password_reset", intent: { type: "password_reset", payload: passwordReset } },
    { type: "quote_approved", intent: { type: "quote_approved", payload: quote } },
    { type: "draft_order_invoice", intent: { type: "draft_order_invoice", payload: draftInvoice } },
  ];
}

describe("Notification preference — default policy never suppresses transactional intents", () => {
  it("classifies every intent as transactional", () => {
    for (const { intent } of everyIntent()) {
      expect(classifyNotification(intent)).toBe("transactional");
    }
  });

  it("DefaultNotificationPreferencePolicy returns false for every intent", async () => {
    const policy = new DefaultNotificationPreferencePolicy();
    for (const { intent } of everyIntent()) {
      expect(await policy.isSuppressed("buyer@example.com", intent)).toBe(false);
    }
  });
});

describe("Notification preference — suppression happens BEFORE the provider call", () => {
  it("a suppressed intent makes ZERO provider calls and returns a NULL receipt, leaving the intent untouched", async () => {
    const logger = new NoopLogger();
    let called = 0;
    const service = new ResendNotificationService({
      apiKey: "re_test_key",
      fromEmail: "store@example.com",
      logger,
      httpClient: async () => {
        called += 1;
        return new Response(JSON.stringify({ id: "msg-x" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      },
      preferences: { isSuppressed: async () => true },
    });

    const input = everyIntent()[0].intent;
    const before = JSON.stringify(input);
    const result: NotificationDispatchResult = await service.sendPaymentConfirmation(
      input.payload as PaymentConfirmationNotification,
    );

    // Zero provider invocation + null receipt (the durable terminal outcome).
    expect(called).toBe(0);
    expect(result.providerMessageId).toBeNull();
    // Preference suppression never mutates the business intent it was handed.
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("Notification preference — a suppressed dispatch is TERMINAL (no retry loop)", () => {
  it("a NULL-receipt dispatched row is never re-enqueued and cannot be resurrected", async () => {
    const outbox = new InMemoryNotificationOutboxRepository();
    const intent = everyIntent()[0].intent;
    await outbox.append("row-1", intent);

    // The worker persists the suppression outcome exactly as a normal dispatch
    // with a NULL receipt: `dispatched` is terminal in the state machine.
    await outbox.markDispatched("row-1", {
      providerMessageId: null,
      jobId: "notification:payment_confirmation:order-1",
    });

    const row = outbox.rows[0];
    expect(row.status).toBe("dispatched");
    expect(row.providerMessageId).toBeNull();

    // No retry loop: the sweep only relays PENDING rows, so a dispatched row is
    // never re-enqueued...
    const sweep = new EnqueuePendingNotificationsUseCase(
      outbox,
      new FakeQueueService(),
      new InMemoryAuditLogService(),
      { generate: () => "audit-1" },
      new NoopLogger(),
    );
    const result = await sweep.execute();
    expect(result).toEqual({ enqueued: 0, failed: 0, poisoned: 0 });

    // ...and the guarded transitions are no-ops: a terminal row can never be
    // re-dispatched, failed, or queued again.
    await outbox.markFailed("row-1", "should not apply");
    await outbox.markDispatched("row-1", {
      providerMessageId: "msg-2",
      jobId: "other-job",
    });
    expect(outbox.rows[0].status).toBe("dispatched");
    expect(outbox.rows[0].providerMessageId).toBeNull();
    expect(outbox.rows[0].jobId).toBe("notification:payment_confirmation:order-1");
  });
});