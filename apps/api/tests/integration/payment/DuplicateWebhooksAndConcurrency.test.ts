// apps/api/tests/integration/payment/DuplicateWebhooksAndConcurrency.test.ts
//
// INTEGRATION TESTS — duplicate deliveries and concurrent races never produce
// a second obligation, order, transaction, or charge.
//
//   1. A duplicate webhook after finalization resolves to the SAME order and
//      the payment stays captured exactly once.
//   2. Two CONCURRENT finalizations for the same reference race past the
//      idempotency fast-path; the database UNIQUE guard (order.
//      transaction_reference / transaction.reference) makes exactly ONE win,
//      and the loser resolves idempotently to the committed order — one order,
//      one transaction, cart converted once, payment captured once.
//   3. Two CONCURRENT initializations for the same cart race to claim the
//      obligation; the UNIQUE obligation/reference guard yields exactly ONE
//      durable obligation and both callers converge on the SAME application
//      reference — a second charge is impossible.
//   4. A transaction row whose order is missing is a terminal
//      DUPLICATE_TRANSACTION anomaly (never re-finalized).
//   5. The verification gate still passes on an already-captured obligation
//      (a duplicate event for settled money is acceptable and idempotent).

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import {
  createPaymentHarness,
  buildDefaultPaymentCart,
} from "./harness";
import { DepthAwareBarrierTransactionManager } from "../../fakes/DepthAwareBarrierTransactionManager";
import { Transaction } from "@api/domain/entities/Transaction";
import { Payment } from "@api/domain/entities/Payment";

const OBLIGATION_AMOUNT_MINOR = 61000;

function seedInitializedObligation(
  h: ReturnType<typeof createPaymentHarness>,
): void {
  h.paymentRepository.seed(
    new Payment({
      id: "payment-1",
      obligationType: "checkout",
      obligationId: "cart-1",
      reference: "CLP-checkout-cart-1",
      amountMinor: OBLIGATION_AMOUNT_MINOR,
      currency: "ngn",
      subtotalMinor: 60000,
      discountMinor: 5000,
      taxMinor: 3000,
      shippingMinor: 2500,
      insuranceMinor: 500,
      status: "initialized",
      providerReference: "pay-CLP-checkout-cart-1",
      providerPaymentUrl: "https://pay.example/authorize/CLP-checkout-cart-1",
      metadata: {
        cartId: "cart-1",
        lineItems: [
          { id: "line-1", variantId: "variant-1", quantity: 2, unitPriceMinor: 25000 },
          { id: "line-2", variantId: "variant-2", quantity: 1, unitPriceMinor: 10000 },
        ],
      },
    }),
  );
}

const FINALIZE_INPUT = {
  cartId: "cart-1",
  transactionReference: "CLP-checkout-cart-1",
  amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
  currency: "ngn",
  expectedAmountMinor: OBLIGATION_AMOUNT_MINOR,
  actorId: "system",
};

describe("Concurrent finalization — the UNIQUE guard wins; the loser resolves idempotently", () => {
  it("two racing finalizations produce ONE order, ONE transaction, cart converted once, payment captured once", async () => {
    const h = createPaymentHarness({
      transactionManager: new DepthAwareBarrierTransactionManager(2),
    });
    seedInitializedObligation(h);

    // Both callers pass the idempotency fast-path BEFORE either commits; the
    // barrier releases them together so the loser deterministically collides
    // on the UNIQUE order.transaction_reference inside the unit of work. The
    // depth-aware barrier models Kysely's nested-transaction semantics: the
    // seeded obligation carries no reservations, so the nested confirmation
    // unit is a no-op and both actors resolve the winner's order.
    const [first, second] = await Promise.all([
      h.finalizeOrderTransaction.execute(FINALIZE_INPUT),
      h.finalizeOrderTransaction.execute(FINALIZE_INPUT),
    ]);

    // Both resolve the SAME committed order.
    expect(second.id).toBe(first.id);
    expect(h.orderRepository.all).toHaveLength(1);
    expect(h.transactionRepository.all).toHaveLength(1);

    // The cart was converted exactly once.
    expect(h.cart.isConverted()).toBe(true);
    expect(h.cart.orderId).toBe(first.id);

    // The payment was captured exactly once (idempotent markCaptured).
    expect(h.paymentRepository.all).toHaveLength(1);
    expect(h.paymentRepository.all[0].status).toBe("captured");
  });
});

describe("Concurrent initialization — exactly one durable obligation", () => {
  it("two racing initializations yield ONE obligation and a shared reference (no second charge)", async () => {
    const h = createPaymentHarness({
      transactionManager: new DepthAwareBarrierTransactionManager(2),
    });

    const [first, second] = await Promise.allSettled([
      h.initializePaymentSession.execute({ cartId: "cart-1" }),
      h.initializePaymentSession.execute({ cartId: "cart-1" }),
    ]);

    // The UNIQUE obligation/reference guard allows exactly ONE active row.
    expect(h.paymentRepository.all).toHaveLength(1);
    const obligation = h.paymentRepository.all[0];
    expect(obligation.reference).toBe("CLP-checkout-cart-1");
    expect(obligation.status).toBe("initialized");

    // The winner resolves the canonical result; whoever wins, both callers
    // converge on the SAME application reference, so the gateway idempotency
    // key is a single charge either way.
    const fulfilledCount = [first, second].filter(
      (r) => r.status === "fulfilled",
    ).length;
    expect(fulfilledCount).toBeGreaterThan(0);
    for (const settled of [first, second]) {
      if (settled.status === "fulfilled") {
        expect(settled.value.reference).toBe("CLP-checkout-cart-1");
      }
    }

    // Every gateway initialization for the obligation carries the SAME
    // reference — a distinct transaction for the same charge is impossible.
    for (const init of h.paymentService.checkoutInitializations) {
      expect(init.reference).toBe("CLP-checkout-cart-1");
    }

    // The cart is payment-initialized exactly once.
    expect(h.cart.isPaymentInitialized()).toBe(true);
  });

  it("the repository itself rejects a second ACTIVE obligation for the same cart (the DB guard)", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    // Simulate a concurrent claim racing past the in-memory fast-path: the
    // insert collides on the UNIQUE (obligation_type, obligation_id) +
    // UNIQUE(reference) guards and surfaces DUPLICATE.
    await expect(() =>
      h.paymentRepository.save(
        new Payment({
          id: "id-999",
          obligationType: "checkout",
          obligationId: "cart-1",
          reference: "CLP-checkout-cart-1",
          amountMinor: OBLIGATION_AMOUNT_MINOR,
          currency: "ngn",
          subtotalMinor: 60000,
          discountMinor: 5000,
          taxMinor: 3000,
          shippingMinor: 2500,
          insuranceMinor: 500,
          status: "initialization_pending",
        }),
      ),
    ).rejectsWithCode("DUPLICATE");

    expect(h.paymentRepository.all).toHaveLength(1);
  });
});

describe("Duplicate deliveries and data anomalies", () => {
  it("a duplicate webhook after finalization resolves to the SAME order, payment captured once", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    const first = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);
    const second = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);

    expect(second.id).toBe(first.id);
    expect(h.orderRepository.all).toHaveLength(1);
    expect(h.transactionRepository.all).toHaveLength(1);
    expect(h.paymentRepository.all[0].status).toBe("captured");
    expect(h.cart.isConverted()).toBe(true);
  });

  it("a transaction row without its order is a terminal DUPLICATE_TRANSACTION anomaly", async () => {
    const h = createPaymentHarness();
    // Orphaned ledger row: the transaction reference is already processed but
    // its order row is missing — retrying cannot repair the anomaly.
    h.transactionRepository.seed(
      new Transaction({
        id: "tx-orphan",
        orderId: "order-missing",
        reference: "CLP-checkout-cart-1",
        amountMinor: OBLIGATION_AMOUNT_MINOR,
      }),
    );

    await expect(() =>
      h.finalizeOrderTransaction.execute(FINALIZE_INPUT),
    ).rejectsWithCode("DUPLICATE_TRANSACTION");

    // No order or second transaction was ever created.
    expect(h.orderRepository.all).toHaveLength(0);
    expect(h.transactionRepository.all).toHaveLength(1);
    expect(h.cart.isConverted()).toBe(false);
  });

  it("the verification gate passes on an already-captured obligation (duplicate event is acceptable)", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });
    await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);

    // The obligation is now captured; a re-delivered success event for the
    // SAME amount/currency still passes verification (captured is an
    // acceptable state) and finalization resolves idempotently.
    await expect(() =>
      h.verifyPaymentEvent.execute({
        cartId: "cart-1",
        transactionReference: "CLP-checkout-cart-1",
        amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
        reportedCurrency: "ngn",
      }),
    ).resolves();

    const replayed = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);
    expect(replayed.id).toBe(h.orderRepository.all[0].id);
    expect(h.orderRepository.all).toHaveLength(1);
  });

  it("a fresh harness with a non-converted cart still refuses to re-initialize after success", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    await expect(() =>
      h.initializePaymentSession.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("INVALID_OPERATION");
    expect(h.paymentRepository.all).toHaveLength(1);
  });
});