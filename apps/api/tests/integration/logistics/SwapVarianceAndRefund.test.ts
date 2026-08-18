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
//      swap replacement hold CONFIRMED (L9), ledger record, payment
//      captured — idempotent on replay. The RETURNED variant is NOT
//      auto-restocked (it becomes sellable only after receipt inspection).
//   8. The swap replacement variant is RESERVED through the L9 ledger at swap
//      creation (swap-scoped deterministic key anchored on the swap id) and
//      replays idempotently; an insufficient replacement shortfall fails
//      closed BEFORE any payment obligation or refund is created.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import {
  createSwapHarness,
  seedReplacementPrice,
  REPLACEMENT_VARIANT_ID,
  SWAP_LOCATION_ID,
} from "./swapHarness";
import { buildSwapOrder } from "../../fixtures/orderFactory";
import { InventoryLevel } from "@api/domain/entities/InventoryLevel";
import { MoneyAmount } from "@api/domain/entities/MoneyAmount";
import type { IPricingService } from "@api/domain/interfaces/services/IPricingService";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Recording stub for the IPricingService seam. Returns a canned authoritative
 * price and records every (variantId, regionId) it was consulted with, so a
 * test can prove the use case resolves unit price through the seam and NEVER
 * reaches into the money_amount repository directly.
 */
class RecordingPricingService implements IPricingService {
  calls: { variantId: string; regionId: string }[] = [];
  constructor(private readonly price: number | null) {}
  async getPriceForRegion(
    variantId: string,
    regionId: string,
  ): Promise<number | null> {
    this.calls.push({ variantId, regionId });
    return this.price;
  }
}

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
  it("resolves the replacement price through IPricingService — never the money_amount repository directly", async () => {
    // The repository is seeded with a DIFFERENT price than the injected seam
    // returns. If the use case bypassed IPricingService and read the repo
    // directly it would use the seeded value; using the seam's value proves the
    // single unit-price resolution path is honored (no DB bypass).
    const recording = new RecordingPricingService(32000);
    const h = createSwapHarness({ pricingService: recording });
    h.moneyAmountRepository.seed(
      new MoneyAmount({
        id: "price-variant-9-direct",
        variantId: REPLACEMENT_VARIANT_ID,
        regionId: "region-ng",
        amountMinor: 21000,
      }),
    );

    const result = await h.processOrderSwapVariance.execute(SWAP_INPUT);

    // The variance reflects the SEAM's authoritative price, not the repo row:
    // 32000 - 25000 = 7000 upcharge.
    expect(result.variance).toBe(7000);
    expect(h.swapRepository.all[0].differenceMinor).toBe(7000);
    // The obligation amount is the seam-derived variance.
    const obligation = await h.paymentRepository.findByReference(
      `CLP-swap-${h.swapRepository.all[0].id}`,
    );
    expect(obligation!.amountMinor).toBe(7000);

    // The seam was consulted exactly once, for the replacement variant in the
    // order's originating region (the cart region of the order).
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0].variantId).toBe(REPLACEMENT_VARIANT_ID);
    expect(recording.calls[0].regionId).toBe("region-ng");
  });

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
    // Every swap replacement must be RESERVABLE through the L9 ledger — seed
    // levels for the additional variants the guard test swaps into.
    h.inventoryLevelRepository.seed(
      new InventoryLevel({
        id: "level-variant-8",
        variantId: "variant-8",
        locationId: SWAP_LOCATION_ID,
        availableQuantity: 10,
      }),
    );
    h.inventoryLevelRepository.seed(
      new InventoryLevel({
        id: "level-variant-7",
        variantId: "variant-7",
        locationId: SWAP_LOCATION_ID,
        availableQuantity: 10,
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

describe("Swap replacement inventory — L9 hold at creation", () => {
  it("reserves the replacement variant on a swap-scoped key anchored on the resolved swap id", async () => {
    const h = createSwapHarness();
    seedReplacementPrice(h, 30000);

    const result = await h.processOrderSwapVariance.execute(SWAP_INPUT);
    expect(result.action).toBe("PAYMENT_REQUIRED");

    // Exactly ONE hold, swap-scoped, anchored on the deterministic swap id.
    expect(h.inventoryReservationRepository.all).toHaveLength(1);
    const reservation = h.inventoryReservationRepository.all[0];
    expect(reservation.variantId).toBe(REPLACEMENT_VARIANT_ID);
    expect(reservation.quantity).toBe(1);
    expect(reservation.status).toBe("reserved");
    expect(reservation.reservationKey).toBe(
      `reserve:swap:${result.swapId}:${REPLACEMENT_VARIANT_ID}:${SWAP_LOCATION_ID}`,
    );

    // Level: 10 available -> 9 available / 1 reserved.
    const level = await h.inventoryLevelRepository.findByVariantAndLocation(
      REPLACEMENT_VARIANT_ID,
      SWAP_LOCATION_ID,
    );
    expect(level!.availableQuantity).toBe(9);
    expect(level!.reservedQuantity).toBe(1);

    // Idempotent replay: the SAME hold is replayed — never a second
    // reservation and never a double deduction.
    const replay = await h.processOrderSwapVariance.execute(SWAP_INPUT);
    expect(replay.swapId).toBe(result.swapId);
    expect(h.inventoryReservationRepository.all).toHaveLength(1);
    const replayLevel = await h.inventoryLevelRepository.findByVariantAndLocation(
      REPLACEMENT_VARIANT_ID,
      SWAP_LOCATION_ID,
    );
    expect(replayLevel!.reservedQuantity).toBe(1);
    expect(replayLevel!.availableQuantity).toBe(9);
  });

  it("fails closed BEFORE any money moves when the replacement cannot be sourced", async () => {
    const h = createSwapHarness({ replacementVariantInventory: 0 });
    seedReplacementPrice(h, 30000);

    await expect(() =>
      h.processOrderSwapVariance.execute(SWAP_INPUT),
    ).rejectsWithCode("INSUFFICIENT_SINGLE_LOCATION_STOCK");

    // No obligation claimed, no gateway call, no refund, no hold created.
    expect(h.paymentRepository.all).toHaveLength(1);
    expect(h.paymentService.swapInitializations).toHaveLength(0);
    expect(h.paymentService.refundsIssued).toHaveLength(0);
    expect(h.inventoryReservationRepository.all).toHaveLength(0);

    // The swap row is durably persisted as `pending` (compensation state) so a
    // retry once stock is available replays the same swap instead of creating
    // a duplicate — the hold then succeeds and the flow resumes.
    expect(h.swapRepository.all).toHaveLength(1);
    expect(h.swapRepository.all[0].status).toBe("pending");
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

    // Inventory (L9 ledger): the replacement hold reserved at swap creation was
    // CONFIRMED at finalization — its units are consumed (available 9, reserved
    // 0). The RETURNED variant is intentionally NOT auto-restocked: it is
    // physically coming back and only becomes sellable after receipt inspection.
    const replacementLevel = await h.inventoryLevelRepository.findByVariantAndLocation(
      REPLACEMENT_VARIANT_ID,
      SWAP_LOCATION_ID,
    );
    expect(replacementLevel!.availableQuantity).toBe(9);
    expect(replacementLevel!.reservedQuantity).toBe(0);
    const returnedLevel =
      await h.inventoryLevelRepository.findByVariantAndLocation(
        "variant-1",
        SWAP_LOCATION_ID,
      );
    expect(returnedLevel!.availableQuantity).toBe(10);
    expect(returnedLevel!.reservedQuantity).toBe(0);
    expect(h.inventoryReservationRepository.all).toHaveLength(1);
    expect(h.inventoryReservationRepository.all[0].status).toBe("confirmed");
    expect(h.inventoryReservationRepository.all[0].reservationKey).toBe(
      `reserve:swap:${result.swapId}:${REPLACEMENT_VARIANT_ID}:${SWAP_LOCATION_ID}`,
    );

    // The legacy variant-level counters are untouched by finalization.
    expect(h.returnedVariant.inventoryQuantity).toBe(10);
    expect(h.replacementVariant.inventoryQuantity).toBe(10);

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