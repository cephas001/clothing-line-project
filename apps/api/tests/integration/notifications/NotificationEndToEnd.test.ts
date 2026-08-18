// apps/api/tests/integration/notifications/NotificationEndToEnd.test.ts
//
// E2E TESTS — the full L8 notification pipeline through the REAL application
// code, from a committed business event to a dispatched provider receipt:
//
//   COMMITTED EVENT -> DURABLE OUTBOX -> SAFE SWEEP -> DETERMINISTIC JOB
//   -> WORKER (processNotificationEventJob) -> INotificationService -> RESEND
//   -> MARK DISPATCHED -> AUDIT
//
// The committed event is produced by the REAL FinalizeOrderTransactionUseCase
// (payment harness); the outbox is the in-memory mirror of migrations 0014/0015;
// the sweep is the REAL EnqueuePendingNotificationsUseCase; the worker is the
// REAL `apps/worker/src/workers/NotificationEventWorker` handler extracted as
// `processNotificationEventJob` (no BullMQ/Redis — the job is driven directly
// against in-memory fakes); the provider is the configurable FakeNotificationService.
//
// FAILURE INJECTION (PART 9/10/18):
//   - malformed payload   -> permanent VALIDATION_ERROR, never sent
//   - missing outbox row  -> terminal RESOURCE_NOT_FOUND
//   - already dispatched  -> acknowledged, never re-sent
//   - Resend 500          -> transient, row stays queued, retry succeeds
//   - Resend terminal     -> row FAILED, never resurrected
//   - DB failure while marking dispatched -> provider called, row stays queued,
//     retry persists the receipt
//   - worker crash BEFORE provider call   -> nothing sent, redelivery sends once
//   - worker crash AFTER provider call    -> send recorded, no receipt, the
//     documented at-least-once redelivery, then the receipt closes the window
//   - concurrent workers -> persistence is idempotent (guarded markDispatched)

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { createPaymentHarness } from "../payment/harness";
import { EnqueuePendingNotificationsUseCase } from "@api/use-cases/notifications/EnqueuePendingNotificationsUseCase";
import type { EnqueuePendingNotificationsResult } from "@api/use-cases/notifications/EnqueuePendingNotificationsUseCase";
import { InMemoryNotificationOutboxRepository } from "../../fakes/InMemoryNotificationOutboxRepository";
import { FakeQueueService } from "../../fakes/FakeQueueService";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { InMemoryTransactionManager } from "../../fakes/InMemoryTransactionManager";
import { FailingTransactionManager } from "../../fakes/FailingTransactionManager";
import { BarrierTransactionManager } from "../../fakes/BarrierTransactionManager";
import { FakeNotificationService } from "../../fakes/FakeNotificationService";
import { NoopLogger } from "../../fakes/NoopLogger";
import { processNotificationEventJob } from "../../../../worker/src/workers/NotificationEventWorker";
import {
  classifyError,
  PermanentJobFailure,
} from "../../../../worker/src/workers/QueueWorker";
import type { WorkerJob } from "../../../../worker/src/workers/QueueWorker";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import {
  QUEUE_NAMES,
  buildNotificationJobId,
} from "@api/domain/shared/jobs";
import type { NotificationEventJobPayload } from "@api/domain/shared/jobs";

const NOTIFICATION_QUEUE = QUEUE_NAMES.notificationEvents;
const OBLIGATION_AMOUNT_MINOR = 61000;

const FINALIZE_INPUT = {
  cartId: "cart-1",
  transactionReference: "CLP-checkout-cart-1",
  amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
  currency: "ngn",
  expectedAmountMinor: OBLIGATION_AMOUNT_MINOR,
  actorId: "system",
};

interface E2EChain {
  outbox: InMemoryNotificationOutboxRepository;
  queue: FakeQueueService;
  audit: InMemoryAuditLogService;
  orderId: string;
  job: WorkerJob<NotificationEventJobPayload>;
  sweep: EnqueuePendingNotificationsResult;
}

function workerDeps(
  chain: E2EChain,
  service: FakeNotificationService,
  transactionManager = new InMemoryTransactionManager(),
): Parameters<typeof processNotificationEventJob>[0] {
  return {
    outboxRepository: chain.outbox,
    notificationService: service,
    transactionManager,
    logger: new NoopLogger(),
  };
}

/**
 * Drive the REAL chain up to the worker's doorstep: finalize a captured
 * checkout (committed event + ONE durable outbox row), relay it with the sweep
 * (ONE deterministic job), and hand back the recorded job for the worker.
 */
async function commitAndSweep(): Promise<E2EChain> {
  const h = createPaymentHarness();
  await h.initializePaymentSession.execute({ cartId: "cart-1" });
  await h.verifyPaymentEvent.execute({
    cartId: "cart-1",
    transactionReference: "CLP-checkout-cart-1",
    amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
    reportedCurrency: "ngn",
  });
  const order = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);

  // COMMITTED EVENT -> DURABLE OUTBOX: exactly one payment_confirmation row.
  expect(h.notificationOutboxRepository.rows).toHaveLength(1);

  // SAFE SWEEP -> DETERMINISTIC JOB.
  const queue = new FakeQueueService();
  const audit = h.auditLogService;
  const sweep = new EnqueuePendingNotificationsUseCase(
    h.notificationOutboxRepository,
    queue,
    audit,
    { generate: () => `audit-e2e-${Math.random().toString(36).slice(2, 8)}` },
    new NoopLogger(),
  );
  const sweepResult = await sweep.execute();
  expect(sweepResult).toEqual({ enqueued: 1, failed: 0, poisoned: 0 });

  const recorded = queue.jobs.filter((j) => j.queueName === NOTIFICATION_QUEUE);
  expect(recorded).toHaveLength(1);

  const job: WorkerJob<NotificationEventJobPayload> = {
    id: recorded[0].options?.jobId ?? "job-1",
    name: NOTIFICATION_QUEUE,
    attemptsMade: 0,
    data: recorded[0].payload as NotificationEventJobPayload,
  };

  return {
    outbox: h.notificationOutboxRepository,
    queue,
    audit,
    orderId: order.id,
    job,
    sweep: sweepResult,
  };
}

describe("E2E — COMMITTED EVENT -> DURABLE OUTBOX -> SAFE SWEEP -> DETERMINISTIC JOB -> WORKER -> RESEND -> MARK DISPATCHED -> AUDIT", () => {
  it("delivers ONE notification end-to-end: one row, one deterministic jobId, one provider call, a dispatched row with the receipt", async () => {
    const chain = await commitAndSweep();
    const service = new FakeNotificationService();

    // WORKER -> INotificationService -> RESEND -> MARK DISPATCHED.
    await processNotificationEventJob(workerDeps(chain, service), chain.job);

    // Exactly one durable outbox row, now terminal dispatched.
    expect(chain.outbox.rows).toHaveLength(1);
    const row = chain.outbox.rows[0];
    expect(row.status).toBe("dispatched");
    expect(row.providerMessageId).toBe("msg_123");
    expect(row.jobId).toBe(chain.job.id);
    expect(row.dispatchedAt).not.toBeNull();

    // The deterministic jobId is the idempotency key derived from the intent.
    expect(chain.job.id).toBe(
      buildNotificationJobId(row.payload, row.discriminator),
    );
    expect(chain.job.id).toBe(`notification:payment_confirmation:${chain.orderId}`);

    // Exactly one provider dispatch of the frozen intent.
    expect(service.sentCount).toBe(1);
    expect(service.calls[0].intentType).toBe("payment_confirmation");

    // AUDIT: the sweep audited the enqueue that produced the deliverable job.
    expect(chain.audit.actions().includes("NOTIFICATION_ENQUEUED")).toBe(true);
  });

  it("dispatches the FROZEN authoritative intent (frozen money, no provider credentials)", async () => {
    const chain = await commitAndSweep();
    const service = new FakeNotificationService();
    await processNotificationEventJob(workerDeps(chain, service), chain.job);

    const sent = service.calls[0].payload as {
      breakdown: Record<string, unknown>;
      recipient: { email: string };
      transactionReference: string;
    };
    expect(sent.breakdown).toEqual({
      subtotalMinor: 60000,
      discountMinor: 5000,
      taxMinor: 3000,
      shippingMinor: 2500,
      insuranceMinor: 500,
      totalMinor: OBLIGATION_AMOUNT_MINOR,
    });
    expect(sent.recipient.email).toBe("buyer@example.com");
    expect(sent.transactionReference).toBe("CLP-checkout-cart-1");
    // The queue payload / intent carry NO credentials or API key material.
    expect(JSON.stringify(chain.job.data).includes("api")).toBe(false);
  });

  it("a suppressed send (NULL receipt) still transitions the row to dispatched terminally", async () => {
    const chain = await commitAndSweep();
    const service = new FakeNotificationService();
    service.failMode = "suppress";

    await processNotificationEventJob(workerDeps(chain, service), chain.job);

    expect(service.sentCount).toBe(1);
    const row = chain.outbox.rows[0];
    expect(row.status).toBe("dispatched");
    expect(row.providerMessageId).toBeNull();
  });
});

describe("E2E — replay & terminal protection (idempotency)", () => {
  it("replaying the job after dispatch does NOT send again", async () => {
    const chain = await commitAndSweep();
    const service = new FakeNotificationService();
    const deps = workerDeps(chain, service);

    await processNotificationEventJob(deps, chain.job);
    await processNotificationEventJob(deps, chain.job);
    await processNotificationEventJob(deps, chain.job);

    expect(service.sentCount).toBe(1);
    expect(chain.outbox.rows[0].status).toBe("dispatched");
    expect(chain.outbox.rows[0].providerMessageId).toBe("msg_123");
  });

  it("a poison payload is a PERMANENT failure — never sent, never retried", async () => {
    const chain = await commitAndSweep();
    const service = new FakeNotificationService();

    const clone = JSON.parse(JSON.stringify(chain.job.data)) as NotificationEventJobPayload;
    (clone.intent as { payload: { recipient: { email: string } } }).payload.recipient.email =
      "not-an-email";
    const poisonJob: WorkerJob<NotificationEventJobPayload> = {
      ...chain.job,
      data: clone,
    };

    let thrown: unknown;
    try {
      await processNotificationEventJob(workerDeps(chain, service), poisonJob);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(thrown instanceof DomainError).toBe(true);
    expect((thrown as DomainError).code).toBe("VALIDATION_ERROR");
    expect(classifyError(thrown)).toBe("permanent");
    expect(service.sentCount).toBe(0);
    // The durable row is untouched (still queued — the payload never resolved).
    expect(chain.outbox.rows[0].status).toBe("queued");
  });

  it("a job whose outbox row is MISSING is a terminal RESOURCE_NOT_FOUND", async () => {
    const chain = await commitAndSweep();
    const service = new FakeNotificationService();

    const orphanJob: WorkerJob<NotificationEventJobPayload> = {
      ...chain.job,
      data: { ...chain.job.data, outboxRecordId: "no-such-row" },
    };

    let thrown: unknown;
    try {
      await processNotificationEventJob(workerDeps(chain, service), orphanJob);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(thrown instanceof PermanentJobFailure).toBe(true);
    expect((thrown as PermanentJobFailure).code).toBe("RESOURCE_NOT_FOUND");
    expect(classifyError(thrown)).toBe("terminal");
    expect(service.sentCount).toBe(0);
  });

  it("an already-DISPATCHED row is acknowledged without a resend (late duplicate)", async () => {
    const chain = await commitAndSweep();
    const service = new FakeNotificationService();
    const deps = workerDeps(chain, service);

    await processNotificationEventJob(deps, chain.job);
    // A duplicate delivery that arrives AFTER completion must not re-send.
    await processNotificationEventJob(deps, chain.job);

    expect(service.sentCount).toBe(1);
    expect(chain.outbox.rows[0].status).toBe("dispatched");
  });
});

describe("E2E — provider failure injection (Resend)", () => {
  it("Resend 500 (transient): rethrown for retry, row stays queued, the next delivery succeeds", async () => {
    const chain = await commitAndSweep();
    const service = new FakeNotificationService();
    service.failMode = "transient";

    let thrown: unknown;
    try {
      await processNotificationEventJob(workerDeps(chain, service), chain.job);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(classifyError(thrown)).toBe("retry");
    expect(service.sentCount).toBe(1);
    // The row is NOT marked dispatched or failed — a retry can fix it.
    expect(chain.outbox.rows[0].status).toBe("queued");
    expect(chain.outbox.rows[0].providerMessageId).toBeNull();

    // Retry with the failure consumed: exactly one more delivery, then receipt.
    service.failMode = "none";
    await processNotificationEventJob(workerDeps(chain, service), chain.job);
    expect(chain.outbox.rows[0].status).toBe("dispatched");
    expect(chain.outbox.rows[0].providerMessageId).toBe("msg_123");
    expect(service.sentCount).toBe(2);
  });

  it("Resend terminal rejection (GATEWAY_AUTH): row marked FAILED, permanent failure, never resurrected", async () => {
    const chain = await commitAndSweep();
    const service = new FakeNotificationService();
    service.failMode = "terminal";

    let thrown: unknown;
    try {
      await processNotificationEventJob(workerDeps(chain, service), chain.job);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(thrown instanceof PermanentJobFailure).toBe(true);
    expect((thrown as PermanentJobFailure).code).toBe("NOTIFICATION_DISPATCH_REJECTED");
    expect(classifyError(thrown)).toBe("terminal");
    expect(service.sentCount).toBe(1);
    expect(chain.outbox.rows[0].status).toBe("failed");
    expect(chain.outbox.rows[0].lastError).toContain("authentication");

    // A redelivery NEVER resurrects a failed row.
    service.failMode = "none";
    await processNotificationEventJob(workerDeps(chain, service), chain.job);
    expect(service.sentCount).toBe(1);
    expect(chain.outbox.rows[0].status).toBe("failed");
  });

  it("DB failure while marking dispatched: provider called, row stays queued, a retry persists the receipt", async () => {
    const chain = await commitAndSweep();
    const service = new FakeNotificationService();
    const txn = new FailingTransactionManager();
    txn.failNext = new Error("database unavailable while persisting dispatch receipt");

    let thrown: unknown;
    try {
      await processNotificationEventJob(workerDeps(chain, service, txn), chain.job);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(classifyError(thrown)).toBe("retry");
    expect(service.sentCount).toBe(1);
    expect(chain.outbox.rows[0].status).toBe("queued");
    expect(chain.outbox.rows[0].providerMessageId).toBeNull();

    // Retry against a healthy DB: the provider is reached again (at-least-once
    // window) and the receipt finally lands.
    await processNotificationEventJob(
      workerDeps(chain, service, new InMemoryTransactionManager()),
      chain.job,
    );
    expect(chain.outbox.rows[0].status).toBe("dispatched");
    expect(chain.outbox.rows[0].providerMessageId).toBe("msg_123");
    expect(service.sentCount).toBe(2);
  });
});

describe("E2E — worker crash windows (before / after the provider call)", () => {
  it("crash BEFORE the provider call: nothing sent, row stays queued, the redelivery sends exactly once", async () => {
    const chain = await commitAndSweep();
    const service = new FakeNotificationService();
    service.failMode = "crash-before";

    let thrown: unknown;
    try {
      await processNotificationEventJob(workerDeps(chain, service), chain.job);
    } catch (err) {
      thrown = err;
    }

    expect(classifyError(thrown)).toBe("retry");
    // The provider was never contacted — no send can have happened.
    expect(service.sentCount).toBe(0);
    expect(chain.outbox.rows[0].status).toBe("queued");

    // The redelivered job sends exactly once.
    service.failMode = "none";
    await processNotificationEventJob(workerDeps(chain, service), chain.job);
    expect(service.sentCount).toBe(1);
    expect(chain.outbox.rows[0].status).toBe("dispatched");
  });

  it("crash AFTER the provider accepted: send recorded but no receipt, the redelivery re-sends, then the receipt closes the window", async () => {
    const chain = await commitAndSweep();
    const service = new FakeNotificationService();
    service.failMode = "crash-after";

    let thrown: unknown;
    try {
      await processNotificationEventJob(workerDeps(chain, service), chain.job);
    } catch (err) {
      thrown = err;
    }

    expect(classifyError(thrown)).toBe("retry");
    // The provider accepted the send (recorded) but the receipt never landed.
    expect(service.sentCount).toBe(1);
    expect(chain.outbox.rows[0].status).toBe("queued");

    // Redelivery re-sends once (the documented at-least-once sub-window) and
    // the receipt finally closes it.
    service.failMode = "none";
    await processNotificationEventJob(workerDeps(chain, service), chain.job);
    expect(service.sentCount).toBe(2);
    expect(chain.outbox.rows[0].status).toBe("dispatched");

    // Once dispatched, a further replay never sends again.
    await processNotificationEventJob(workerDeps(chain, service), chain.job);
    expect(service.sentCount).toBe(2);
  });
});

describe("E2E — concurrent workers (idempotent persistence under duplicate delivery)", () => {
  it("two racing deliveries both reach the provider, but the guarded markDispatched leaves ONE terminal dispatched row; later replays never send", async () => {
    const chain = await commitAndSweep();
    const service = new FakeNotificationService();
    const barrier = new BarrierTransactionManager(2);

    const [first, second] = await Promise.all([
      processNotificationEventJob(workerDeps(chain, service, barrier), chain.job),
      processNotificationEventJob(workerDeps(chain, service, barrier), chain.job),
    ]);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();

    // Both deliveries dispatched (the only duplicate sub-window is provider
    // calls before the receipt lands), but the guarded UPDATE means the row is
    // terminal exactly once and never errors.
    expect(service.sentCount).toBe(2);
    expect(chain.outbox.rows).toHaveLength(1);
    expect(chain.outbox.rows[0].status).toBe("dispatched");
    expect(chain.outbox.rows[0].providerMessageId).toBe("msg_123");

    // Any further duplicate delivery is acknowledged without a send.
    await processNotificationEventJob(workerDeps(chain, service), chain.job);
    expect(service.sentCount).toBe(2);
  });
});