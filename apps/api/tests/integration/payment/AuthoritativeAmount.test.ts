// apps/api/tests/integration/payment/AuthoritativeAmount.test.ts
//
// INTEGRATION TESTS — the authoritative financial lifecycle.
//
// Proves, end-to-end through the application boundary:
//
//   1. The charge amount is computed SERVER-side from durable state and frozen
//      into the durable payment obligation BEFORE the gateway is contacted.
//      amountMinor === subtotal - discount + tax + shipping + insurance.
//   2. The gateway receives EXACTLY the frozen values (amount, currency,
//      reference) — no client-provided financial value can influence it.
//   3. A webhook is verified against the FROZEN obligation amount:
//      correct amount passes; underpayment, overpayment, and currency
//      mismatch all fail with stable domain codes.
//   4. Unknown references and wrong-cart contexts fail CLOSED.
//   5. Replay is idempotent — one obligation, one gateway call, same URL.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import {
  createPaymentHarness,
  buildDefaultPaymentCart,
} from "./harness";
import { buildCheckoutCart } from "../../fixtures/cartFactory";

const OBLIGATION_AMOUNT_MINOR = 61000;

describe("Payment initialization — authoritative amount (no client-provided values)", () => {
  it("initializes a session with the server-computed amount and freezes it durably", async () => {
    const h = createPaymentHarness();

    const result = await h.initializePaymentSession.execute({
      cartId: "cart-1",
      actorId: "customer-1",
    });

    expect(result.authorizationUrl).toBeDefined();
    expect(result.reference).toBe("CLP-checkout-cart-1");

    const obligation = await h.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    expect(obligation).not.toBeNull();
    expect(obligation!.amountMinor).toBe(OBLIGATION_AMOUNT_MINOR);
    expect(obligation!.breakdown).toEqual({
      subtotalMinor: 60000,
      discountMinor: 5000,
      taxMinor: 3000,
      shippingMinor: 2500,
      insuranceMinor: 500,
      totalMinor: OBLIGATION_AMOUNT_MINOR,
    });
    expect(obligation!.currency).toBe("ngn");
    expect(obligation!.status).toBe("initialized");
  });

  it("sends EXACTLY the frozen obligation values to the gateway (never a client amount)", async () => {
    const h = createPaymentHarness();

    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    expect(h.paymentService.checkoutInitializations).toHaveLength(1);
    const obligation = h.paymentService.checkoutInitializations[0];
    expect(obligation.amountMinor).toBe(OBLIGATION_AMOUNT_MINOR);
    expect(obligation.currency).toBe("ngn");
    expect(obligation.reference).toBe("CLP-checkout-cart-1");
    expect(obligation.email).toBe("buyer@example.com");
    // The gateway never sees a client-specified total/discount/tax/shipping/
    // insurance — only the frozen single authoritative amount.
    expect(JSON.stringify(obligation)).not.toContain("subtotalMinor");
    expect(JSON.stringify(obligation)).not.toContain("discountMinor");
    expect(JSON.stringify(obligation)).not.toContain("taxMinor");
    expect(obligation.metadata).toBeDefined();
    expect((obligation.metadata as { cartId?: string }).cartId).toBe("cart-1");
  });

  it("exposes ONLY authorizationUrl + reference to the client boundary", async () => {
    const h = createPaymentHarness();

    const result = await h.initializePaymentSession.execute({ cartId: "cart-1" });

    expect(Object.keys(result).sort()).toEqual(["authorizationUrl", "reference"]);
    expect(JSON.stringify(result)).not.toContain("amountMinor");
    expect(JSON.stringify(result)).not.toContain("currency");
  });

  it("replays the SAME result in the crash-window case without a second gateway obligation", async () => {
    const h = createPaymentHarness();

    const first = await h.initializePaymentSession.execute({ cartId: "cart-1" });

    // Simulate the crash window the replay path exists for: the durable
    // obligation was persisted (with its authorization URL) but the cart
    // mirror was not. A retry must return the EXISTING URL and NEVER contact
    // the gateway again or create a second obligation.
    h.cart.clearPaymentInitialization();

    const second = await h.initializePaymentSession.execute({ cartId: "cart-1" });

    expect(second.authorizationUrl).toBe(first.authorizationUrl);
    expect(second.reference).toBe(first.reference);
    expect(h.paymentService.checkoutInitializations).toHaveLength(1);
    expect(h.paymentRepository.all).toHaveLength(1);
  });

  it("returns 409 INVALID_OPERATION for a fully initialized cart (no re-charge attempt)", async () => {
    const h = createPaymentHarness();

    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    await expect(() =>
      h.initializePaymentSession.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("INVALID_OPERATION");
    // No second obligation, no second gateway call.
    expect(h.paymentRepository.all).toHaveLength(1);
    expect(h.paymentService.checkoutInitializations).toHaveLength(1);
  });

  it("fails when the cart carries no shipping selection (no un-validated charge)", async () => {
    const h = createPaymentHarness({
      cart: buildCheckoutCart({ id: "cart-1", shippingQuotes: [] }),
    });

    await expect(() =>
      h.initializePaymentSession.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("INVALID_STATE");
  });
});

describe("Payment verification — the webhook is validated against the FROZEN obligation", () => {
  it("accepts a webhook whose captured amount and currency match exactly", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    await expect(() =>
      h.verifyPaymentEvent.execute({
        cartId: "cart-1",
        transactionReference: "CLP-checkout-cart-1",
        amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
        reportedCurrency: "ngn",
      }),
    ).resolves();
  });

  it("rejects an UNDERPAYMENT with INVALID_PAYMENT_AMOUNT", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    await expect(() =>
      h.verifyPaymentEvent.execute({
        cartId: "cart-1",
        transactionReference: "CLP-checkout-cart-1",
        amountPaidMinor: OBLIGATION_AMOUNT_MINOR - 1,
        reportedCurrency: "ngn",
      }),
    ).rejectsWithCode("INVALID_PAYMENT_AMOUNT");
  });

  it("rejects an OVERPAYMENT with INVALID_PAYMENT_AMOUNT", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    await expect(() =>
      h.verifyPaymentEvent.execute({
        cartId: "cart-1",
        transactionReference: "CLP-checkout-cart-1",
        amountPaidMinor: OBLIGATION_AMOUNT_MINOR + 1,
        reportedCurrency: "ngn",
      }),
    ).rejectsWithCode("INVALID_PAYMENT_AMOUNT");
  });

  it("rejects a CURRENCY MISMATCH with INVALID_CURRENCY", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    await expect(() =>
      h.verifyPaymentEvent.execute({
        cartId: "cart-1",
        transactionReference: "CLP-checkout-cart-1",
        amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
        reportedCurrency: "usd",
      }),
    ).rejectsWithCode("INVALID_CURRENCY");
  });

  it("fails CLOSED for an unknown payment reference (a signed webhook alone is never enough)", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    await expect(() =>
      h.verifyPaymentEvent.execute({
        cartId: "cart-1",
        transactionReference: "CLP-checkout-unknown",
        amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
        reportedCurrency: "ngn",
      }),
    ).rejectsWithCode("PAYMENT_VERIFICATION_FAILED");
  });

  it("fails when the obligation does not belong to the expected checkout context", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    await expect(() =>
      h.verifyPaymentEvent.execute({
        cartId: "cart-2",
        transactionReference: "CLP-checkout-cart-1",
        amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
        reportedCurrency: "ngn",
      }),
    ).rejectsWithCode("PAYMENT_VERIFICATION_FAILED");
  });
});

describe("Payment initialization — defensive guards", () => {
  it("refuses to re-initialize a cart that is already paid", async () => {
    const cart = buildDefaultPaymentCart("cart-1");
    cart.markPaid({});
    const h = createPaymentHarness({ cart });

    await expect(() =>
      h.initializePaymentSession.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("INVALID_OPERATION");
  });

  it("refuses to initialize a cart that was already converted to an order", async () => {
    const cart = buildDefaultPaymentCart("cart-1");
    cart.markConverted({ orderId: "order-1" });
    const h = createPaymentHarness({ cart });

    await expect(() =>
      h.initializePaymentSession.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("INVALID_OPERATION");
  });

  it("refuses to initialize when the shipping currency mismatches the region currency", async () => {
    // The selection stays internally consistent (quote + selection both usd)
    // so the guard under test is the region-currency comparison, not the
    // consistency check.
    const h = createPaymentHarness({
      cart: buildCheckoutCart({
        id: "cart-1",
        shippingCurrency: "usd",
      }),
    });

    await expect(() =>
      h.initializePaymentSession.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("INVALID_OPERATION");
  });
});