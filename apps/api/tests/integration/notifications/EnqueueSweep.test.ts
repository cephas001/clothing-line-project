// apps/api/tests/integration/notifications/EnqueueSweep.test.ts
//
// INTEGRATION TESTS — the AFTER-COMMIT half of the L8 pipeline: the
// EnqueuePendingNotificationsUseCase sweep that relays durable outbox rows onto
// the notification queue.
//
// CRASH-SAFETY PROOFS:
//   1. A row is marked queued ONLY after the job was accepted — never before.
//   2. A transient queue failure leaves the row pending for the next sweep and
//      does not abort the batch.
//   3. A corrupt row is POISONED terminally (marked failed + NOTIFICATION_POISONED
//      audit) so the sweep never spins on it forever.
//   4. The deterministic jobId collapses duplicate deliveries onto ONE job —
//      a replay can never enqueue a second copy of the same notification.
//   5. Failed enqueues are audited with the exact RepositoryError code.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { EnqueuePendingNotificationsUseCase } from "@api/use-cases/notifications/EnqueuePendingNotificationsUseCase";
import { InMemoryNotificationOutboxRepository } from "../../fakes/InMemoryNotificationOutboxRepository";
import { FakeQueueService } from "../../fakes/FakeQueueService";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { NoopLogger } from "../../fakes/NoopLogger";
import { RepositoryErrorCode } from "@api/domain/interfaces/shared/errors/RepositoryError";
import type {
  NotificationIntent,
  PaymentConfirmationNotification,
} from "@api/domain/shared/notifications";
import { QUEUE_NAMES } from "@api/domain/shared/jobs";

const NOTIFICATION_QUEUE = QUEUE_NAMES.notificationEvents;

function paymentConfirmationIntent(orderId: string): NotificationIntent {
  const payload: PaymentConfirmationNotification = {
    recipient: { email: "buyer@example.com", name: "Ada Okafor" },
    order: {
      orderId,
      cartId: `cart-${orderId}`,
      customerId: "customer-1",
      currency: "ngn",
      createdAt: "2026-08-15T10:00:00.000Z",
    },
    transactionReference: `CLP-checkout-cart-${orderId}`,
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
  return { type: "payment_confirmation", payload };
}

interface SweepHarness {
  outbox: InMemoryNotificationOutboxRepository;
  queue: FakeQueueService;
  audit: InMemoryAuditLogService;
  sweep: EnqueuePendingNotificationsUseCase;
}

function createSweepHarness(): SweepHarness {
  const outbox = new InMemoryNotificationOutboxRepository();
  const queue = new FakeQueueService();
  const audit = new InMemoryAuditLogService();
  const sweep = new EnqueuePendingNotificationsUseCase(
    outbox,
    queue,
    audit,
    { generate: () => `audit-${Math.random().toString(36).slice(2, 10)}` },
    new NoopLogger(),
  );
  return { outbox, queue, audit, sweep };
}

describe("Sweep — relay pending outbox rows onto the notification queue", () => {
  it("enqueues pending rows with deterministic jobIds and marks them queued ONLY after", async () => {
    const h = createSweepHarness();
    await h.outbox.append("row-1", paymentConfirmationIntent("order-1"));
    await h.outbox.append("row-2", paymentConfirmationIntent("order-2"));

    const result = await h.sweep.execute();

    expect(result).toEqual({ enqueued: 2, failed: 0, poisoned: 0 });

    const jobs = h.queue.jobs.filter((j) => j.queueName === NOTIFICATION_QUEUE);
    expect(jobs).toHaveLength(2);
    // Deterministic idempotency keys: notification:<type>:<aggregateId>.
    expect(jobs.map((j) => j.options?.jobId)).toEqual([
      "notification:payment_confirmation:order-1",
      "notification:payment_confirmation:order-2",
    ]);
    // The payload carries the durable intent + the row id for the dispatcher.
    const first = jobs[0].payload as { outboxRecordId: string };
    expect(first.outboxRecordId).toBe("row-1");

    // Marked queued AFTER acceptance, with the same jobId the worker holds.
    const row1 = h.outbox.rows.find((r) => r.id === "row-1")!;
    expect(row1.status).toBe("queued");
    expect(row1.jobId).toBe("notification:payment_confirmation:order-1");
    expect(h.audit.actions().filter((a) => a === "NOTIFICATION_ENQUEUED")).toHaveLength(2);
  });
});

describe("Sweep — transient queue failure is crash-safe", () => {
  it("a CONNECTION failure leaves the row pending, is audited, and the NEXT sweep succeeds", async () => {
    const h = createSweepHarness();
    await h.outbox.append("row-1", paymentConfirmationIntent("order-1"));

    h.queue.failWithCode = RepositoryErrorCode.CONNECTION;
    const first = await h.sweep.execute();

    expect(first).toEqual({ enqueued: 0, failed: 1, poisoned: 0 });
    // The row is NOT marked queued without a live job — still pending.
    const row = h.outbox.rows.find((r) => r.id === "row-1")!;
    expect(row.status).toBe("pending");
    expect(row.jobId).toBeNull();
    const auditEntry = h.audit.entries.find(
      (l) => l.action === "NOTIFICATION_ENQUEUE_FAILED",
    );
    expect(auditEntry?.details?.errorCode).toBe(RepositoryErrorCode.CONNECTION);

    // Next sweep (failure consumed) succeeds exactly once.
    h.queue.failWithCode = undefined;
    const second = await h.sweep.execute();
    expect(second).toEqual({ enqueued: 1, failed: 0, poisoned: 0 });
    expect(h.outbox.rows[0].status).toBe("queued");
    expect(h.queue.jobs.filter((j) => j.queueName === NOTIFICATION_QUEUE)).toHaveLength(1);
  });

  it("a per-row failure does not abort the rest of the batch", async () => {
    const h = createSweepHarness();
    await h.outbox.append("row-1", paymentConfirmationIntent("order-1"));
    await h.outbox.append("row-2", paymentConfirmationIntent("order-2"));

    h.queue.failWithCode = RepositoryErrorCode.TIMEOUT;
    const result = await h.sweep.execute();

    // Every row was attempted; all failed transiently, none left half-marked.
    expect(result.failed).toBe(2);
    expect(h.outbox.rows.every((r) => r.status === "pending")).toBe(true);
  });
});

describe("Sweep — corrupt rows are poisoned, never spun on", () => {
  it("a malformed intent is marked failed terminally with a NOTIFICATION_POISONED audit", async () => {
    const h = createSweepHarness();
    // A row whose recipient email is invalid: notificationAggregateId still
    // resolves (orderId), but the queue contract validator
    // (parseNotificationEventJobPayload) rejects it.
    const corrupt = paymentConfirmationIntent("order-bad");
    corrupt.payload.recipient = { email: "not-an-email", name: "Bad" };
    await h.outbox.append("row-bad", corrupt);

    const result = await h.sweep.execute();

    expect(result).toEqual({ enqueued: 0, failed: 0, poisoned: 1 });
    const bad = h.outbox.rows[0];
    expect(bad.status).toBe("failed");
    expect(bad.lastError).toContain("email");
    expect(h.audit.actions().includes("NOTIFICATION_POISONED")).toBe(true);
    expect(h.queue.jobs.filter((j) => j.queueName === NOTIFICATION_QUEUE)).toHaveLength(0);
  });

  it("a poisoned row is never picked up again by a later sweep", async () => {
    const h = createSweepHarness();
    const corrupt = paymentConfirmationIntent("order-bad");
    corrupt.payload.recipient = { email: "not-an-email", name: "Bad" };
    await h.outbox.append("row-bad", corrupt);

    await h.sweep.execute();
    const result = await h.sweep.execute();

    expect(result.poisoned).toBe(0);
    expect(h.outbox.rows[0].status).toBe("failed");
  });
});

describe("Sweep — DUPLICATE jobId conflict resolution (T3 -> L8-R PART 14)", () => {
  it("resolves a DUPLICATE against a LIVE job as already-queued (row marked queued, never double-enqueued)", async () => {
    const h = createSweepHarness();
    await h.outbox.append("row-1", paymentConfirmationIntent("order-1"));

    // A job with the deterministic id already exists and is LIVE (waiting):
    // a prior delivery is in-flight, so the relay must NOT enqueue a copy.
    await h.queue.enqueueJob(NOTIFICATION_QUEUE, { outboxRecordId: "row-1" }, {
      jobId: "notification:payment_confirmation:order-1",
    });

    const result = await h.sweep.execute();

    // The row is effectively already queued: marked queued with the same
    // deterministic jobId, counted as enqueued, and NO second job was created.
    expect(result).toEqual({ enqueued: 1, failed: 0, poisoned: 0 });
    expect(h.queue.jobs.filter((j) => j.queueName === NOTIFICATION_QUEUE)).toHaveLength(1);
    const row = h.outbox.rows[0];
    expect(row.status).toBe("queued");
    expect(row.jobId).toBe("notification:payment_confirmation:order-1");
    expect(h.audit.actions().includes("NOTIFICATION_ALREADY_QUEUED")).toBe(true);
  });

  it("FAILS CLOSED when the existing job cannot be proven valid (failed state) — row stays pending", async () => {
    const h = createSweepHarness();
    await h.outbox.append("row-1", paymentConfirmationIntent("order-1"));

    // A dead-lettered (failed) job with the deterministic id exists: it will
    // never be delivered, so marking the row queued would strand it. The sweep
    // must fail closed — never mark queued against an unprovable job.
    await h.queue.enqueueJob(NOTIFICATION_QUEUE, { outboxRecordId: "row-1" }, {
      jobId: "notification:payment_confirmation:order-1",
    });
    h.queue.jobStates.set("notification:payment_confirmation:order-1", "failed");

    const result = await h.sweep.execute();

    expect(result).toEqual({ enqueued: 0, failed: 1, poisoned: 0 });
    expect(h.outbox.rows[0].status).toBe("pending");
    expect(h.outbox.rows[0].jobId).toBeNull();
  });

  it("FAILS CLOSED when no existing job can be proven — row stays pending", async () => {
    const h = createSweepHarness();
    await h.outbox.append("row-1", paymentConfirmationIntent("order-1"));

    // Enqueue surface the DUPLICATE, but the queue cannot resolve any job
    // (e.g. the job was removed between operations): do not mark queued.
    h.queue.failWithCode = RepositoryErrorCode.DUPLICATE;

    const result = await h.sweep.execute();

    expect(result).toEqual({ enqueued: 0, failed: 1, poisoned: 0 });
    expect(h.outbox.rows[0].status).toBe("pending");
    expect(h.queue.jobs.filter((j) => j.queueName === NOTIFICATION_QUEUE)).toHaveLength(0);
  });
});