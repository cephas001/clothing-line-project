// apps/api/tests/integration/notifications/RecipientSecurity.test.ts
//
// INTEGRATION TESTS — webhook/queue inputs can NEVER steer who is notified.
//
// The recipient of every notification comes from a FROZEN authoritative record
// (the checkout snapshot / durable order), never from the webhook body, the
// queue job, or any provider response. A malicious or malformed webhook that
// omits — or even tries to smuggle — an email cannot redirect a notification.
//
// PROOFS:
//   1. The courier tracking webhook input has NO email field, structurally;
//      the tracking_update intent is still addressed to the frozen snapshot.
//   2. Even if the webhook body carries an (ignored) extra `email` field, the
//      intent recipient is still the frozen snapshot — the producer use case
//      derives recipients from the aggregate, not the raw event.
//   3. The shipment_dispatched intent is addressed from the frozen checkout
//      destination, and the queue job payload carries only intent data — no
//      provider credentials ever appear in any outbox row or queue payload.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import {
  createLogisticsHarness,
  buildLogisticsEvent,
} from "../logistics/logisticsHarness";
import type {
  LogisticsEventJobPayload,
  NotificationEventJobPayload,
} from "@api/domain/shared/jobs";
import { EnqueuePendingNotificationsUseCase } from "@api/use-cases/notifications/EnqueuePendingNotificationsUseCase";
import { FakeQueueService } from "../../fakes/FakeQueueService";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { NoopLogger } from "../../fakes/NoopLogger";

/** Seed a dispatched local fulfillment for the provider shipment the webhook cites. */
function seedDispatchedFulfillment(
  h: ReturnType<typeof createLogisticsHarness>,
): void {
  h.fulfillmentRepository.seed({
    id: "f-sec-1",
    orderId: "order-1",
    trackingNumber: "TRK-1",
    providerShipmentId: "SB-123",
    status: "dispatched",
    courier: "DHL",
  });
}

describe("Recipient security — the webhook cannot control the recipient", () => {
  it("a tracking webhook with NO email field still addresses the frozen snapshot email", async () => {
    const h = createLogisticsHarness();
    seedDispatchedFulfillment(h);
    const webhook = buildLogisticsEvent({
      eventKey: "shipbubble:evt-sec-1",
      eventType: "tracking.status_changed",
      status: "in_transit",
    });

    // The raw webhook contract has no recipient information at all.
    expect("email" in webhook).toBe(false);

    await h.processCourierTrackingEvent.execute({ logisticsEvent: webhook });

    const row = h.notificationOutboxRepository.rows[0];
    expect(row.intentType).toBe("tracking_update");
    if (row.payload.type === "tracking_update") {
      // Recipient is the FROZEN order snapshot, not anything from the webhook.
      expect(row.payload.payload.recipient.email).toBe("buyer@example.com");
      expect(row.payload.payload.recipient.name).toBe("Ada Okafor");
    }
  });

  it("a webhook that smuggles an email field cannot redirect the recipient", async () => {
    const h = createLogisticsHarness();
    seedDispatchedFulfillment(h);
    const smuggle = buildLogisticsEvent({
      eventKey: "shipbubble:evt-sec-2",
      eventType: "delivery.completed",
      status: "delivered",
    }) as LogisticsEventJobPayload & { email?: string };
    // An attacker-controlled (or simply buggy) extra field the mapper must NOT
    // trust — the producer derives recipients from the aggregate.
    smuggle.email = "attacker@evil.example";

    await h.processCourierTrackingEvent.execute({ logisticsEvent: smuggle });

    const row = h.notificationOutboxRepository.rows[0];
    if (row.payload.type === "tracking_update") {
      expect(row.payload.payload.recipient.email).toBe("buyer@example.com");
      expect(row.payload.payload.recipient.email).not.toBe("attacker@evil.example");
    }
  });
});

describe("Recipient security — dispatch is addressed from the frozen checkout snapshot", () => {
  it("the shipment_dispatched intent carries only the snapshot identity and zero credentials", async () => {
    const h = createLogisticsHarness();
    const result = await h.dispatchOrderFulfillment.execute({ orderId: "order-1" });

    const row = h.notificationOutboxRepository.rows[0];
    expect(row.intentType).toBe("shipment_dispatched");
    if (row.payload.type === "shipment_dispatched") {
      expect(row.payload.payload.recipient.email).toBe("buyer@example.com");
      expect(row.payload.payload.providerShipmentId).toBe("SB-ORDER-1");
    }

    // The outbox row carries ONLY intent data — no keys, no provider secrets.
    const serialized = JSON.stringify(row.payload);
    expect(serialized).not.toMatch(/api[-_]?key|authorization|secret|bearer/i);

    // The relayed QUEUE payload is the same contract — still no credentials.
    const queue = new FakeQueueService();
    const sweep = new EnqueuePendingNotificationsUseCase(
      h.notificationOutboxRepository,
      queue,
      new InMemoryAuditLogService(),
      { generate: () => "audit-1" },
      new NoopLogger(),
    );
    await sweep.execute();

    const job = queue.jobs[0].payload as NotificationEventJobPayload;
    expect(job.intent.type).toBe("shipment_dispatched");
    expect(JSON.stringify(job)).not.toMatch(/api[-_]?key|authorization|secret|bearer/i);
    // Deterministic idempotency key — aggregate-scoped (the local fulfillment
    // id, the stable aggregate), never PII and never the provider secret.
    expect(queue.jobs[0].options?.jobId).toBe(
      `notification:shipment_dispatched:${result.fulfillmentId}`,
    );
  });
});