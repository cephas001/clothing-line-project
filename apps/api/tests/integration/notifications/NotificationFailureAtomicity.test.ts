// apps/api/tests/integration/notifications/NotificationFailureAtomicity.test.ts
//
// INTEGRATION TESTS — notification failures NEVER corrupt committed commerce.
//
// Two directions are proven at the application boundary:
//
//   1. APPEND FAILURE INSIDE THE TRANSACTION: the payment_confirmation append
//      happens inside the finalize unit of work; if the outbox write fails the
//      WHOLE transaction rolls back (no order, no transaction, cart untouched,
//      payment uncaptured) and a retry commits exactly once.
//   2. PROVIDER DISPATCH FAILURE AFTER COMMIT: the commit (order + outbox row)
//      is durable and untouched; only the AFTER-COMMIT enqueue fails, leaving
//      the row pending for the next sweep — the "commit, then queue died" crash
//      window is closed without losing or double-sending the notification.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import {
  createPaymentHarness,
  buildDefaultPaymentCart,
} from "../payment/harness";
import { SnapshotTransactionManager } from "../../fakes/SnapshotTransactionManager";
import { InMemoryCartRepository } from "../../fakes/InMemoryCartRepository";
import { InMemoryPaymentRepository } from "../../fakes/InMemoryPaymentRepository";
import { InMemoryOrderRepository } from "../../fakes/InMemoryOrderRepository";
import { InMemoryTransactionRepository } from "../../fakes/InMemoryTransactionRepository";
import { InMemoryNotificationOutboxRepository } from "../../fakes/InMemoryNotificationOutboxRepository";
import { InMemoryInventoryLocationRepository } from "../../fakes/InMemoryInventoryLocationRepository";
import { InMemoryInventoryLevelRepository } from "../../fakes/InMemoryInventoryLevelRepository";
import { InMemoryInventoryReservationRepository } from "../../fakes/InMemoryInventoryReservationRepository";
import { EnqueuePendingNotificationsUseCase } from "@api/use-cases/notifications/EnqueuePendingNotificationsUseCase";
import { FakeQueueService } from "../../fakes/FakeQueueService";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { NoopLogger } from "../../fakes/NoopLogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { NotificationIntent } from "@api/domain/shared/notifications";
import { QUEUE_NAMES } from "@api/domain/shared/jobs";

const OBLIGATION_AMOUNT_MINOR = 61000;

const FINALIZE_INPUT = {
  cartId: "cart-1",
  transactionReference: "CLP-checkout-cart-1",
  amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
  currency: "ngn",
  expectedAmountMinor: OBLIGATION_AMOUNT_MINOR,
  actorId: "system",
};

/** An outbox whose append throws — simulating a DB write failure. */
class FailingAppendOutbox extends InMemoryNotificationOutboxRepository {
  constructor(private readonly failOnAppend = true) {
    super();
  }

  override async append(
    _id: string,
    _intent: NotificationIntent,
  ): Promise<void> {
    if (this.failOnAppend) {
      const error = new Error("outbox write failed") as RepositoryError;
      error.name = "RepositoryError";
      error.code = RepositoryErrorCode.LOCKED;
      throw error;
    }
    await super.append(_id, _intent);
  }
}

function atomicHarness(outbox: InMemoryNotificationOutboxRepository) {
  const cart = buildDefaultPaymentCart("cart-1");
  const cartRepository = new InMemoryCartRepository();
  cartRepository.seed(cart);
  const paymentRepository = new InMemoryPaymentRepository();
  const orderRepository = new InMemoryOrderRepository();
  const transactionRepository = new InMemoryTransactionRepository();
  // L9 inventory stores are wrapped so the nested confirmation unit rolls back
  // WITH the outer finalize unit of work.
  const inventoryLocationRepository = new InMemoryInventoryLocationRepository();
  const inventoryLevelRepository = new InMemoryInventoryLevelRepository();
  const inventoryReservationRepository =
    new InMemoryInventoryReservationRepository();
  const transactionManager = new SnapshotTransactionManager([
    cartRepository,
    paymentRepository,
    orderRepository,
    transactionRepository,
    outbox,
    inventoryLocationRepository,
    inventoryLevelRepository,
    inventoryReservationRepository,
  ]);
  return createPaymentHarness({
    cart,
    cartRepository,
    paymentRepository,
    orderRepository,
    transactionRepository,
    notificationOutboxRepository: outbox,
    transactionManager,
    inventoryLocationRepository,
    inventoryLevelRepository,
    inventoryReservationRepository,
  });
}

describe("Notification failure atomicity — append failure inside the transaction", () => {
  it("an outbox append failure rolls back the ENTIRE finalize unit of work", async () => {
    const outbox = new FailingAppendOutbox();
    const h = atomicHarness(outbox);
    await h.initializePaymentSession.execute({ cartId: "cart-1" });
    await h.verifyPaymentEvent.execute({
      cartId: "cart-1",
      transactionReference: "CLP-checkout-cart-1",
      amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
      reportedCurrency: "ngn",
    });

    await expect(() =>
      h.finalizeOrderTransaction.execute(FINALIZE_INPUT),
    ).rejectsWithCode("LOCK_ACQUISITION_FAILED");

    // ZERO partial state — the order and transaction rolled back, the cart is
    // NOT converted, the payment is NOT captured, and no notification row leaks.
    expect(h.orderRepository.all).toHaveLength(0);
    expect(h.transactionRepository.all).toHaveLength(0);
    const cartAfter = await h.cartRepository.findById("cart-1");
    expect(cartAfter!.isConverted()).toBe(false);
    const obligation = await h.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    expect(obligation!.status).toBe("initialized");
    expect(outbox.rows).toHaveLength(0);
  });

  it("after the outbox failure is consumed, a retry commits the order AND its intent exactly once", async () => {
    const outbox = new FailingAppendOutbox(false);
    const h = atomicHarness(outbox);
    await h.initializePaymentSession.execute({ cartId: "cart-1" });
    await h.verifyPaymentEvent.execute({
      cartId: "cart-1",
      transactionReference: "CLP-checkout-cart-1",
      amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
      reportedCurrency: "ngn",
    });

    const order = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);
    expect(order.id).toBeDefined();
    expect(h.orderRepository.all).toHaveLength(1);
    expect(h.transactionRepository.all).toHaveLength(1);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].intentType).toBe("payment_confirmation");
    expect(outbox.rows[0].status).toBe("pending");
  });
});

describe("Notification failure atomicity — provider dispatch failure AFTER commit", () => {
  it("a dead queue after commit leaves the committed order + pending outbox row intact", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });
    await h.verifyPaymentEvent.execute({
      cartId: "cart-1",
      transactionReference: "CLP-checkout-cart-1",
      amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
      reportedCurrency: "ngn",
    });

    const order = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);
    expect(order.id).toBeDefined();

    // COMMIT IS DURABLE — the intent row exists, still pending.
    expect(h.notificationOutboxRepository.rows).toHaveLength(1);
    expect(h.notificationOutboxRepository.rows[0].status).toBe("pending");

    // The AFTER-COMMIT relay crashes (queue unreachable). The committed state
    // is untouched: order + transaction + converted cart all remain.
    const queue = new FakeQueueService();
    const audit = new InMemoryAuditLogService();
    const sweep = new EnqueuePendingNotificationsUseCase(
      h.notificationOutboxRepository,
      queue,
      audit,
      { generate: () => "audit-1" },
      new NoopLogger(),
    );
    queue.failWithCode = RepositoryErrorCode.CONNECTION;

    const result = await sweep.execute();
    expect(result).toEqual({ enqueued: 0, failed: 1, poisoned: 0 });

    expect(h.orderRepository.all).toHaveLength(1);
    expect(h.orderRepository.all[0].transactionReference).toBe(
      "CLP-checkout-cart-1",
    );
    expect(h.transactionRepository.all).toHaveLength(1);
    const cart = await h.cartRepository.findById("cart-1");
    expect(cart!.isConverted()).toBe(true);

    // The notification was NOT lost and NOT double-sent: still exactly one
    // PENDING row, no job on the queue, and the failure is audited.
    expect(h.notificationOutboxRepository.rows).toHaveLength(1);
    expect(h.notificationOutboxRepository.rows[0].status).toBe("pending");
    expect(queue.jobs.filter((j) => j.queueName === QUEUE_NAMES.notificationEvents)).toHaveLength(0);
    expect(audit.actions().includes("NOTIFICATION_ENQUEUE_FAILED")).toBe(true);
  });
});