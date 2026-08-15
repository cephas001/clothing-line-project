// apps/api/tests/integration/logistics/SwapVarianceAndRefund.test.ts
//
// INTEGRATION TESTS — the swap financial lifecycle: variance computation,
// durable payment obligation for upcharges, and the idempotent, guarded refund
// flow for credits. Financial invariants asserted here:
//
//   1. The replacement price is NEVER client-supplied — it is resolved
//      server-side from the regional money_amount row, so the variance is
//      computed from authoritative state and is stable across re-runs.
//   2. An upcharge creates a durable swap payment obligation (UNIQUE
//      reference, frozen order currency) BEFORE the gateway is contacted, and
//      a replay returns the SAME URL with exactly ONE gateway call.
//   3. A refund is a durable Refund row identified by
//      (provider_transaction_reference, amount_minor); a replay never issues a
//      second gateway refund.
//   4. Refunds are capped by a cumulative guard against the captured amount:
//      an amount exceeding remaining = captured - sum(non-failed refunds) is
//      refused (INVALID_OPERATION).
//   5. An ambiguous refund outcome (gateway timeout) stays 'pending' and a
//      retry surfaces REFUND_REQUIRES_REVIEW — never a blind re-issue.
//   6. When the captured obligation cannot be resolved or the order lacks a
//      transaction reference, the refund is routed to manual review rather
//      than issued unguarded.
//   7. Finalization (upcharge captured) is ONE atomic unit: swap completed,
//      order total adjusted ONLY by the variance, replacement line added,
//      returned variant restocked, replacement variant deducted, ledger
//      record, payment captured — idempotent on replay.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import {
  createSwapHarness,
  seedReplacementPrice,
  REPLACEMENT_VARIANT_ID,
} from "./swapHarness";
import { buildSwapOrder } from "../../fixtures/orderFactory";
import { MoneyAmount } from "@api/domain/entities/MoneyAmount";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

const SWAP_INPUT = {
  orderId: "order-1",
  returnLineItemId: "line-1",
  returnQuantity: 1,
  newVariantId: REPLACEMENT_VARIANT_ID,
  actorId: "customer-1",
};

function gatewayTimeout(): RepositoryError {
  const error = new Error("gateway timed out") as RepositoryError;
  error.name = "RepositoryError";
  error.code = RepositoryErrorCode.TIMEOUT;
  return error;
}

describe("Swap variance — server-authoritative pricing", () => {
  it("an upcharge (new price 30000) creates ONE durable payment obligation and a stable payment URL", async () => {
    const h = createSwapHarness();
    seedReplacementPrice(h, 30000);

    const result = await h.processOrderSwapVariance.execute(SWAP_INPUT);

    expect(result.variance).toBe(5000);
    expect(result.action).toBe("PAYMENT_REQUIRED");
    expect(result.paymentUrl).not.toBeNull();

    const swap = h.swapRepository.all[0];
    expect(swap.status).toBe("awaiting_payment");
    expect(swap.differenceMinor).toBe(5000);
    expect(swap.paymentUrl).toBe(result.paymentUrl ?? null);

    const obligation = await h.paymentRepository.findByReference(
      `CLP-swap-${swap.id}`,
    );
    expect(obligation).not.toBeNull();
    expect(obligation!.obligationType).toBe("swap");
    expect(obligation!.obligationId).toBe(swap.id);
    expect(obligation!.amountMinor).toBe(5000);
    expect(obligation!.currency).toBe("ngn");
    expect(obligation!.status).toBe("initialized");

    // The gateway receives EXACTLY the server values, in the frozen currency.
    expect(h.paymentService.swapInitializations).toHaveLength(1);
    const init = h.paymentService.swapInitializations[0];
    expect(init.amountMinor).toBe(5000);
    expect(init.currency).toBe("ngn");
    expect(init.reference).toBe(`CLP-swap-${swap.id}`);
    expect(init.email).toBe("buyer@example.com");

    // Idempotent replay: same swap, same URL, NO second gateway call.
    const replay = await h.processOrderSwapVariance.execute(SWAP_INPUT);
    expect(replay.swapId).toBe(swap.id);
    expect(replay.paymentUrl).toBe(result.paymentUrl);
    expect(h.swapRepository.all).toHaveLength(1);
    expect(h.paymentService.swapInitializations).toHaveLength(1);

    // The verification gate passes for the upcharge.
    await expect(() =>
      h.verifySwapPaymentEvent.execute({
        swapId: swap.id,
        orderId: "order-1",
        transactionReference: `CLP-swap-${swap.id}`,
        amountPaidMinor: 5000,
        reportedCurrency: "ngn",
      }),
    ).resolves();
  });

  it("a foreign order is refused before any financial computation", async () => {
    const h = createSwapHarness();
    seedReplacementPrice(h, 30000);

    await expect(() =>
      h.processOrderSwapVariance.execute({
        ...SWAP_INPUT,
        actorId: "customer-2",
      }),
    ).rejectsWithCode("PERMISSION_DENIED");

    expect(h.swapRepository.all).toHaveLength(0);
    expect(h.paymentRepository.all).toHaveLength(1);
    expect(h.paymentService.swapInitializations).toHaveLength(0);
  });

  it("a missing regional price for the replacement is a terminal rejection", async () => {
    const h = createSwapHarness();

    await expect(() =>
      h.processOrderSwapVariance.execute(SWAP_INPUT),
    ).rejectsWithCode("REGIONAL_PRICE_MISSING");

    expect(h.swapRepository.all).toHaveLength(0);
  });
});

describe("Swap variance — even exchange", () => {
  it("an identical price (25000) records an EVEN_EXCHANGE with no payment or refund", async () => {
    const h = createSwapHarness();
    seedReplacementPrice(h, 25000);

    const result = await h.processOrderSwapVariance.execute(SWAP_INPUT);

    expect(result.variance).toBe(0);
    expect(result.action).toBe("EVEN_EXCHANGE");
    expect(result.paymentUrl).toBeNull();
    expect(h.swapRepository.all[0].status).toBe("even_exchange");
    expect(h.paymentService.swapInitializations).toHaveLength(0);
    expect(h.paymentService.refundsIssued).toHaveLength(0);

    // Idempotent replay resolves the same swap.
    const replay = await h.processOrderSwapVariance.execute(SWAP_INPUT);
    expect(replay.swapId).toBe(result.swapId);
    expect(h.swapRepository.all).toHaveLength(1);
  });
});

describe("Swap refund — idempotent dispatch and the cumulative guard", () => {
  it("a refund (new price 20000) dispatches a durable refund and replays idempotently", async () => {
    const h = createSwapHarness();
    seedReplacementPrice(h, 20000);

    const result = await h.processOrderSwapVariance.execute(SWAP_INPUT);

    expect(result.variance).toBe(-5000);
    expect(result.action).toBe("REFUND_DISPATCHED");
    expect(result.paymentUrl).toBeNull();

    const swap = h.swapRepository.all[0];
    expect(swap.status).toBe("refund_dispatched");

    expect(h.refundRepository.all).toHaveLength(1);
    const refund = h.refundRepository.all[0];
    expect(refund.refundReference).toBe("RFR-CLP-checkout-cart-1-5000");
    expect(refund.providerTransactionReference).toBe("CLP-checkout-cart-1");
    expect(refund.amountMinor).toBe(5000);
    expect(refund.status).toBe("dispatched");
    expect(refund.providerRefundReference).toBe("refund-CLP-checkout-cart-1-5000");
    expect(refund.paymentId).toBe("payment-checkout-1");

    expect(h.paymentService.refundsIssued).toHaveLength(1);
    expect(h.paymentService.refundsIssued[0].amountMinor).toBe(5000);
    expect(h.paymentService.refundsIssued[0].transactionReference).toBe(
      "CLP-checkout-cart-1",
    );

    // Idempotent replay: one refund row, one gateway call, never re-issued.
    const replay = await h.processOrderSwapVariance.execute(SWAP_INPUT);
    expect(replay.action).toBe("REFUND_DISPATCHED");
    expect(h.refundRepository.all).toHaveLength(1);
    expect(h.paymentService.refundsIssued).toHaveLength(1);
  });

  it("an over-refund (amount > captured) is refused before the gateway is contacted", async () => {
    const h = createSwapHarness({ capturedAmountMinor: 20000 });
    seedReplacementPrice(h, 0); // new value 0 -> refund 25000 > captured 20000

    await expect(() =>
      h.processOrderSwapVariance.execute(SWAP_INPUT),
    ).rejectsWithCode("INVALID_OPERATION");

    expect(h.refundRepository.all).toHaveLength(0);
    expect(h.paymentService.refundsIssued).toHaveLength(0);
  });

  it("the cumulative guard allows successive refunds only while a balance remains", async () => {
    const h = createSwapHarness({ capturedAmountMinor: 20000 });
    seedReplacementPrice(h, 20000); // refund 5000  (remaining starts at 20000)
    h.moneyAmountRepository.seed(
      new MoneyAmount({
        id: "price-variant-8",
        variantId: "variant-8",
        regionId: "region-ng",
        amountMinor: 15000, // refund 10000 (remaining 15000 after the first)
      }),
    );
    h.moneyAmountRepository.seed(
      new MoneyAmount({
        id: "price-variant-7",
        variantId: "variant-7",
        regionId: "region-ng",
        amountMinor: 0, // refund 25000 (remaining only 5000) -> refused
      }),
    );

    const first = await h.processOrderSwapVariance.execute({
      ...SWAP_INPUT,
      newVariantId: REPLACEMENT_VARIANT_ID,
    });
    expect(first.action).toBe("REFUND_DISPATCHED");

    const second = await h.processOrderSwapVariance.execute({
      ...SWAP_INPUT,
      newVariantId: "variant-8",
    });
    expect(second.action).toBe("REFUND_DISPATCHED");

    await expect(() =>
      h.processOrderSwapVariance.execute({
        ...SWAP_INPUT,
        newVariantId: "variant-7",
      }),
    ).rejectsWithCode("INVALID_OPERATION");

    expect(await h.refundRepository.sumRefundedMinor("CLP-checkout-cart-1")).toBe(
      15000,
    );
    expect(h.refundRepository.all).toHaveLength(2);
    expect(h.paymentService.refundsIssued).toHaveLength(2);
    expect(h.swapRepository.all).toHaveLength(3);
  });

  it("an ambiguous gateway outcome stays pending and a retry requires manual review", async () => {
    const h = createSwapHarness();
    seedReplacementPrice(h, 20000);
    h.paymentService.failRefundWith = gatewayTimeout();

    await expect(() =>
      h.processOrderSwapVariance.execute(SWAP_INPUT),
    ).rejectsWithCode("EXTERNAL_SERVICE_TIMEOUT");

    // The refund was claimed (durable) but dispatch is UNCONFIRMED.
    expect(h.refundRepository.all).toHaveLength(1);
    expect(h.refundRepository.all[0].status).toBe("pending");
    expect(h.paymentService.refundsIssued).toHaveLength(1);

    // A retry never re-issues: it surfaces REFUND_REQUIRES_REVIEW.
    h.paymentService.failRefundWith = undefined;
    await expect(() =>
      h.processOrderSwapVariance.execute(SWAP_INPUT),
    ).rejectsWithCode("REFUND_REQUIRES_REVIEW");

    expect(h.refundRepository.all).toHaveLength(1);
    expect(h.paymentService.refundsIssued).toHaveLength(1);
    expect(h.swapRepository.all[0].status).toBe("pending");
  });

  it("an order without a transaction reference routes the refund to manual review", async () => {
    const h = createSwapHarness({
      order: buildSwapOrder({ transactionReference: null }),
    });
    seedReplacementPrice(h, 20000);

    const result = await h.processOrderSwapVariance.execute(SWAP_INPUT);

    expect(result.variance).toBe(-5000);
    expect(result.action).toBe("EVEN_EXCHANGE");
    expect(h.swapRepository.all[0].status).toBe("refund_pending_manual");
    expect(h.refundRepository.all).toHaveLength(0);
    expect(h.paymentService.refundsIssued).toHaveLength(0);
  });
});

describe("Swap finalization — atomic, idempotent", () => {
  it("an upcharge verified and finalized adjusts the order by exactly the variance", async () => {
    const h = createSwapHarness();
    seedReplacementPrice(h, 30000);

    const result = await h.processOrderSwapVariance.execute(SWAP_INPUT);
    const reference = `CLP-swap-${result.swapId}`;

    await h.verifySwapPaymentEvent.execute({
      swapId: result.swapId,
      orderId: "order-1",
      transactionReference: reference,
      amountPaidMinor: 5000,
      reportedCurrency: "ngn",
    });

    const finalized = await h.finalizeSwapTransaction.execute({
      swapId: result.swapId,
      orderId: "order-1",
      transactionReference: reference,
      amountPaidMinor: 5000,
      currency: "ngn",
      actorId: "customer-1",
    });

    expect(finalized.status).toBe("completed");

    // Order total adjusted ONLY by the variance: 61000 - 25000 + 30000.
    expect(h.order.totalAmountMinor).toBe(66000);
    const lines = h.order.lineItems;
    expect(lines).toHaveLength(3);
    const returnedLine = lines.find((li) => li.id === "line-1");
    expect(returnedLine!.quantity).toBe(1);
    const replacementLine = lines.find(
      (li) => li.id === "line-1-swap-variant-9",
    );
    expect(replacementLine!.variantId).toBe("variant-9");
    expect(replacementLine!.quantity).toBe(1);
    expect(replacementLine!.unitPriceMinor).toBe(30000);

    // Inventory: returned variant restocked, replacement deducted.
    expect(h.returnedVariant.inventoryQuantity).toBe(11);
    expect(h.replacementVariant.inventoryQuantity).toBe(9);

    // Ledger record + captured swap payment.
    expect(h.transactionRepository.all).toHaveLength(1);
    expect(h.transactionRepository.all[0].reference).toBe(reference);
    expect(h.transactionRepository.all[0].amountMinor).toBe(5000);
    expect(h.transactionRepository.all[0].orderId).toBe("order-1");
    const obligation = await h.paymentRepository.findByReference(reference);
    expect(obligation!.status).toBe("captured");

    // Idempotent replay: no second ledger row, order not re-adjusted.
    const again = await h.finalizeSwapTransaction.execute({
      swapId: result.swapId,
      orderId: "order-1",
      transactionReference: reference,
      amountPaidMinor: 5000,
      currency: "ngn",
    });
    expect(again.id).toBe(finalized.id);
    expect(h.transactionRepository.all).toHaveLength(1);
    expect(h.order.totalAmountMinor).toBe(66000);
  });

  it("verification rejects a mismatched amount, swap context, and currency", async () => {
    const h = createSwapHarness();
    seedReplacementPrice(h, 30000);
    const result = await h.processOrderSwapVariance.execute(SWAP_INPUT);
    const reference = `CLP-swap-${result.swapId}`;

    await expect(() =>
      h.verifySwapPaymentEvent.execute({
        swapId: result.swapId,
        orderId: "order-1",
        transactionReference: reference,
        amountPaidMinor: 4999,
        reportedCurrency: "ngn",
      }),
    ).rejectsWithCode("INVALID_PAYMENT_AMOUNT");

    await expect(() =>
      h.verifySwapPaymentEvent.execute({
        swapId: "swap-wrong",
        orderId: "order-1",
        transactionReference: reference,
        amountPaidMinor: 5000,
        reportedCurrency: "ngn",
      }),
    ).rejectsWithCode("PAYMENT_VERIFICATION_FAILED");

    await expect(() =>
      h.verifySwapPaymentEvent.execute({
        swapId: result.swapId,
        orderId: "order-1",
        transactionReference: reference,
        amountPaidMinor: 5000,
        reportedCurrency: "usd",
      }),
    ).rejectsWithCode("INVALID_CURRENCY");
  });
});