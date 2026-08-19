// apps/api/tests/integration/payment/IdempotencyAndResetSafety.test.ts
//
// INTEGRATION TESTS — payment-obligation reset releases the mutation lock
// without ever re-opening settled money.
//
// ResetFailedPaymentInitializationUseCase exists so a customer whose gateway
// initialization failed or whose payment page was abandoned can retry. These
// tests prove:
//
//   1. A FAILED gateway attempt leaves a durable `initialization_pending`
//      obligation and an UNINITIALIZED cart; reset transitions it to `failed`
//      and releases the cart without deleting any history.
//   2. An ABANDONED (initialized) obligation resets too, PRESERVING the
//      reference/provider reference/URL/amount/breakdown/metadata — nothing is
//      deleted or cleared.
//   3. After a reset, the NEXT initialization derives a deterministic
//      PER-ATTEMPT reference (-A1, -A2, ...) and the gateway is contacted with
//      a FRESH reference — never a re-used one that already produced a
//      possibly different-amount transaction.
//   4. A SETTLED obligation (captured/refunded) is NEVER resettable; paid,
//      converted, and frozen carts are refused; a foreign cart is refused.
//   5. Reset is a harmless no-op when there is no obligation.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import {
  createPaymentHarness,
  buildDefaultPaymentCart,
} from "./harness";

const OBLIGATION_AMOUNT_MINOR = 61000;

describe("Payment reset — gateway failure releases the cart without deleting history", () => {
  it("a failed gateway attempt leaves a pending obligation and a free cart; reset retries with a fresh reference", async () => {
    const h = createPaymentHarness();

    // Gateway down: the durable obligation is CLAIMED but never initialized.
    h.paymentService.failWith = new Error("gateway down");
    await expect(() =>
      h.initializePaymentSession.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("EXTERNAL_SERVICE_ERROR");

    const pending = await h.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    expect(pending).not.toBeNull();
    expect(pending!.status).toBe("initialization_pending");
    expect(pending!.amountMinor).toBe(OBLIGATION_AMOUNT_MINOR);
    // The cart mirror is only written after the gateway succeeds, so the cart
    // remains free for a retry.
    expect(h.cart.isPaymentInitialized()).toBe(false);

    // Reset releases the lock: the obligation transitions to failed.
    const reset = await h.resetFailedPaymentInitialization.execute({
      cartId: "cart-1",
      actorId: "customer-1",
    });
    expect(reset.resettled).toBe(true);
    expect(reset.priorStatus).toBe("initialization_pending");

    const failed = await h.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    expect(failed!.status).toBe("failed");
    // History is preserved, not deleted.
    expect(failed!.reference).toBe("CLP-checkout-cart-1");
    expect(failed!.amountMinor).toBe(OBLIGATION_AMOUNT_MINOR);

    // Re-initialize: a FRESH obligation with a deterministic per-attempt
    // reference, and the gateway sees the fresh reference — never the re-used
    // one from the failed attempt.
    h.paymentService.failWith = undefined;
    const second = await h.initializePaymentSession.execute({
      cartId: "cart-1",
    });
    expect(second.reference).toBe("CLP-checkout-cart-1-A1");
    expect(h.paymentService.checkoutInitializations).toHaveLength(2);
    expect(h.paymentService.checkoutInitializations[1].reference).toBe(
      "CLP-checkout-cart-1-A1",
    );
    expect(h.paymentRepository.all).toHaveLength(2);
  });

  it("an abandoned (initialized) obligation resets WITHOUT deleting the provider URL/reference/history", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    const reset = await h.resetFailedPaymentInitialization.execute({
      cartId: "cart-1",
      actorId: "customer-1",
    });
    expect(reset.resettled).toBe(true);
    expect(reset.priorStatus).toBe("initialized");

    const failed = await h.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    expect(failed!.status).toBe("failed");
    // The provider reference/URL and the financial snapshot are RETAINED.
    expect(failed!.providerReference).not.toBeNull();
    expect(failed!.providerPaymentUrl).not.toBeNull();
    expect(failed!.reference).toBe("CLP-checkout-cart-1");
    expect(failed!.breakdown).toEqual({
      subtotalMinor: 60000,
      discountMinor: 5000,
      taxMinor: 3000,
      shippingMinor: 2500,
      insuranceMinor: 500,
      totalMinor: OBLIGATION_AMOUNT_MINOR,
    });

    // The cart's payment-initialization MIRROR is cleared (the lock releases)
    // so a re-selection/retry can proceed.
    expect(h.cart.isPaymentInitialized()).toBe(false);

    // Retry produces a fresh per-attempt obligation.
    const second = await h.initializePaymentSession.execute({
      cartId: "cart-1",
    });
    expect(second.reference).toBe("CLP-checkout-cart-1-A1");
    expect(h.paymentRepository.all).toHaveLength(2);
  });
});

describe("Payment reset — per-attempt references are deterministic and never re-used", () => {
  it("two failed attempts + resets produce -A1 then -A2, each with one gateway call on a fresh reference", async () => {
    const h = createPaymentHarness();

    // Attempt 1 fails at the gateway.
    h.paymentService.failWith = new Error("down");
    await expect(() =>
      h.initializePaymentSession.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("EXTERNAL_SERVICE_ERROR");
    await h.resetFailedPaymentInitialization.execute({ cartId: "cart-1" });

    // Attempt 2 fails at the gateway.
    h.paymentService.failWith = new Error("down");
    await expect(() =>
      h.initializePaymentSession.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("EXTERNAL_SERVICE_ERROR");
    await h.resetFailedPaymentInitialization.execute({ cartId: "cart-1" });

    // Attempt 3 succeeds with the -A2 reference.
    h.paymentService.failWith = undefined;
    const third = await h.initializePaymentSession.execute({ cartId: "cart-1" });
    expect(third.reference).toBe("CLP-checkout-cart-1-A2");

    // Three durable rows: the original + two per-attempt retries.
    expect(h.paymentRepository.all).toHaveLength(3);
    expect(
      h.paymentRepository.all.map((p) => p.reference).sort(),
    ).toEqual([
      "CLP-checkout-cart-1",
      "CLP-checkout-cart-1-A1",
      "CLP-checkout-cart-1-A2",
    ]);

    // The gateway was contacted exactly once per attempt, each time with the
    // attempt's FRESH reference (a reference is never re-used across attempts).
    expect(
      h.paymentService.checkoutInitializations.map((o) => o.reference),
    ).toEqual([
      "CLP-checkout-cart-1",
      "CLP-checkout-cart-1-A1",
      "CLP-checkout-cart-1-A2",
    ]);
  });
});

describe("Payment reset — refused where money is already handled", () => {
  it("refuses to reset a SETTLED (captured) obligation with INVALID_OPERATION", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    const obligation = await h.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    obligation!.markCaptured();
    await h.paymentRepository.save(obligation!);

    await expect(() =>
      h.resetFailedPaymentInitialization.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("INVALID_OPERATION");
  });

  it("refuses to reset a SETTLED (refunded) obligation with INVALID_OPERATION", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    const obligation = await h.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    obligation!.markCaptured();
    obligation!.markRefunded(false);
    await h.paymentRepository.save(obligation!);

    await expect(() =>
      h.resetFailedPaymentInitialization.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("INVALID_OPERATION");
  });

  it("refuses to reset a PAID cart", async () => {
    const cart = buildDefaultPaymentCart("cart-1");
    cart.markPaid({});
    const h = createPaymentHarness({ cart });

    await expect(() =>
      h.resetFailedPaymentInitialization.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("INVALID_OPERATION");
  });

  it("refuses to reset a CONVERTED cart", async () => {
    const cart = buildDefaultPaymentCart("cart-1");
    cart.markConverted({ orderId: "order-1" });
    const h = createPaymentHarness({ cart });

    await expect(() =>
      h.resetFailedPaymentInitialization.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("INVALID_OPERATION");
  });

  it("refuses to reset a FROZEN cart", async () => {
    const cart = buildDefaultPaymentCart("cart-1");
    cart.markFrozen({ reason: "quote-in-progress" });
    const h = createPaymentHarness({ cart });

    await expect(() =>
      h.resetFailedPaymentInitialization.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("INVALID_OPERATION");
  });
});

describe("Payment reset — authorization and idempotency", () => {
  it("refuses a FOREIGN cart with PERMISSION_DENIED", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    await expect(() =>
      h.resetFailedPaymentInitialization.execute({
        cartId: "cart-1",
        actorId: "customer-2",
      }),
    ).rejectsWithCode("PERMISSION_DENIED");
  });

  it("is a no-op when there is no obligation (resettled=false)", async () => {
    const h = createPaymentHarness();

    const reset = await h.resetFailedPaymentInitialization.execute({
      cartId: "cart-1",
    });
    expect(reset.resettled).toBe(false);
    expect(h.paymentRepository.all).toHaveLength(0);
  });

  it("resetting an already-failed obligation preserves the row and never re-mutates the cart", async () => {
    const h = createPaymentHarness();

    h.paymentService.failWith = new Error("down");
    await expect(() =>
      h.initializePaymentSession.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("EXTERNAL_SERVICE_ERROR");
    await h.resetFailedPaymentInitialization.execute({ cartId: "cart-1" });

    // A second reset against the already-failed obligation must not create a
    // new row or flip any financial state.
    await h.resetFailedPaymentInitialization.execute({ cartId: "cart-1" });

    expect(h.paymentRepository.all).toHaveLength(1);
    const obligation = h.paymentRepository.all[0];
    expect(obligation.status).toBe("failed");
    expect(obligation.reference).toBe("CLP-checkout-cart-1");
    expect(obligation.amountMinor).toBe(OBLIGATION_AMOUNT_MINOR);
    expect(h.cart.isPaymentInitialized()).toBe(false);
  });
});