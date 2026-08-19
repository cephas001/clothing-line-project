// apps/api/tests/unit/payment/PaymentAmountInvariant.test.ts
//
// DOMAIN UNIT TESTS — Payment entity money/currency/lifecycle invariants.
//
// The durable payment obligation is the single source of financial truth for a
// charge. These tests pin the invariants the whole pipeline relies on:
//
//   - `amountMinor === subtotal - discount + tax + shipping + insurance`
//     (enforced at construction so a mis-priced obligation can NEVER reach the
//     gateway — no underpayments, overpayments, or rounding).
//   - every component is an integer minor unit and never negative; discount
//     cannot exceed subtotal.
//   - `initialized` iff a provider payment URL exists.
//   - lifecycle transitions are guarded (no re-init of settled payments, no
//     capture of refunded payments).
//   - deterministic idempotency references (per-attempt suffixes).

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { Payment, PaymentProps } from "@api/domain/entities/Payment";
import { DomainError } from "@api/domain/entities/errors/DomainError";

function paymentProps(overrides: Partial<PaymentProps> = {}): PaymentProps {
  return {
    id: "pay-1",
    obligationType: "checkout",
    obligationId: "cart-1",
    reference: "CLP-checkout-cart-1",
    amountMinor: 61000,
    currency: "ngn",
    subtotalMinor: 60000,
    discountMinor: 5000,
    taxMinor: 3000,
    shippingMinor: 2500,
    insuranceMinor: 500,
    ...overrides,
  };
}

describe("Payment entity — authoritative amount invariant", () => {
  it("constructs when amountMinor equals subtotal - discount + tax + shipping + insurance", () => {
    const payment = new Payment(paymentProps());
    expect(payment.amountMinor).toBe(61000);
    expect(payment.breakdown).toEqual({
      subtotalMinor: 60000,
      discountMinor: 5000,
      taxMinor: 3000,
      shippingMinor: 2500,
      insuranceMinor: 500,
      totalMinor: 61000,
    });
  });

  it("rejects an UNDERPAYMENT (amountMinor below the authoritative breakdown)", () => {
    expect(() => new Payment(paymentProps({ amountMinor: 60999 })))
      .toThrowWithCode("INVALID_PAYMENT_AMOUNT");
  });

  it("rejects an OVERPAYMENT (amountMinor above the authoritative breakdown)", () => {
    expect(() => new Payment(paymentProps({ amountMinor: 61001 })))
      .toThrowWithCode("INVALID_PAYMENT_AMOUNT");
  });

  it("rejects a zero amount (nothing to charge)", () => {
    expect(() =>
      new Payment(paymentProps({ amountMinor: 0, subtotalMinor: 0 })),
    ).toThrowWithCode("NEGATIVE_AMOUNT");
  });

  it("rejects a negative amount", () => {
    expect(() => new Payment(paymentProps({ amountMinor: -1 })))
      .toThrowWithCode("NEGATIVE_AMOUNT");
  });

  it("rejects a negative discount component", () => {
    expect(() => new Payment(paymentProps({ discountMinor: -1 })))
      .toThrowWithCode("NEGATIVE_AMOUNT");
  });

  it("rejects a fractional (non-integer) component — no floating point money", () => {
    expect(() => new Payment(paymentProps({ taxMinor: 3000.5 })))
      .toThrowWithCode("NEGATIVE_AMOUNT");
  });

  it("rejects a discount that exceeds the subtotal", () => {
    expect(() => new Payment(paymentProps({ discountMinor: 60001 })))
      .toThrowWithCode("INVALID_OPERATION");
  });

  it("defaults an unset component to zero and stays consistent", () => {
    const payment = new Payment(
      paymentProps({
        amountMinor: 60000,
        subtotalMinor: 60000,
        discountMinor: 0,
        taxMinor: 0,
        shippingMinor: 0,
        insuranceMinor: 0,
      }),
    );
    expect(payment.discountMinor).toBe(0);
    expect(payment.taxMinor).toBe(0);
    expect(payment.shippingMinor).toBe(0);
    expect(payment.insuranceMinor).toBe(0);
    expect(payment.breakdown.totalMinor).toBe(60000);
  });

  it("preserves the authoritative currency verbatim on the obligation", () => {
    const payment = new Payment(paymentProps({ currency: "ngn" }));
    expect(payment.currency).toBe("ngn");
  });

  it("rejects a missing id/reference (obligation identity is mandatory)", () => {
    expect(() => new Payment(paymentProps({ id: " " })))
      .toThrowWithCode("VALIDATION_ERROR");
    expect(() => new Payment(paymentProps({ reference: "" })))
      .toThrowWithCode("VALIDATION_ERROR");
  });
});

describe("Payment entity — lifecycle invariants", () => {
  it("defaults to initialization_pending (the gateway has not accepted anything)", () => {
    const payment = new Payment(paymentProps());
    expect(payment.status).toBe("initialization_pending");
    expect(payment.isInitializationPending()).toBe(true);
  });

  it("rejects an `initialized` obligation without a provider payment URL", () => {
    expect(() =>
      new Payment(paymentProps({ status: "initialized", providerPaymentUrl: null })),
    ).toThrowWithCode("INVALID_STATE");
  });

  it("markInitialized records the provider URL and reference", () => {
    const payment = new Payment(paymentProps());
    payment.markInitialized({
      providerReference: "pay-CLP-checkout-cart-1",
      providerPaymentUrl: "https://pay.example/authorize/CLP-checkout-cart-1",
    });
    expect(payment.status).toBe("initialized");
    expect(payment.providerPaymentUrl).toBe(
      "https://pay.example/authorize/CLP-checkout-cart-1",
    );
    expect(payment.providerReference).toBe("pay-CLP-checkout-cart-1");
    expect(payment.isInitializationPending()).toBe(false);
  });

  it("markCaptured is idempotent for an already-captured payment", () => {
    const payment = new Payment(paymentProps());
    payment.markInitialized({
      providerReference: "pay-ref",
      providerPaymentUrl: "https://pay.example/authorize/x",
    });
    payment.markCaptured();
    payment.markCaptured();
    expect(payment.status).toBe("captured");
  });

  it("cannot capture a refunded payment", () => {
    const payment = new Payment(paymentProps());
    payment.markInitialized({
      providerReference: "pay-ref",
      providerPaymentUrl: "https://pay.example/authorize/x",
    });
    payment.markCaptured();
    payment.markRefunded(false);
    expect(() => payment.markCaptured()).toThrowWithCode("INVALID_STATE");
  });

  it("only captured payments can be refunded", () => {
    const payment = new Payment(paymentProps());
    expect(() => payment.markRefunded(false)).toThrowWithCode("INVALID_STATE");
  });

  it("cannot re-initialize a settled payment", () => {
    const payment = new Payment(paymentProps());
    payment.markInitialized({
      providerReference: "pay-ref",
      providerPaymentUrl: "https://pay.example/authorize/x",
    });
    payment.markCaptured();
    expect(() =>
      payment.markInitialized({
        providerPaymentUrl: "https://pay.example/authorize/y",
      }),
    ).toThrowWithCode("INVALID_STATE");
  });

  it("isResettable only for claimed-but-unsettled obligations", () => {
    const pending = new Payment(paymentProps());
    expect(pending.isResettable()).toBe(true);

    const initialized = new Payment(paymentProps());
    initialized.markInitialized({
      providerReference: "pay-ref",
      providerPaymentUrl: "https://pay.example/authorize/x",
    });
    expect(initialized.isResettable()).toBe(true);

    const captured = new Payment(paymentProps());
    captured.markInitialized({
      providerReference: "pay-ref",
      providerPaymentUrl: "https://pay.example/authorize/x",
    });
    captured.markCaptured();
    expect(captured.isResettable()).toBe(false);
  });
});

describe("Payment entity — deterministic idempotency references", () => {
  it("derives the same reference from the same obligation identity", () => {
    expect(Payment.buildReference("checkout", "cart-1")).toBe(
      Payment.buildReference("checkout", "cart-1"),
    );
    expect(Payment.buildReference("checkout", "cart-1")).toBe(
      "CLP-checkout-cart-1",
    );
  });

  it("appends the attempt suffix for retries (attempt 0 keeps the legacy format)", () => {
    expect(Payment.buildReference("checkout", "cart-1", 1)).toBe(
      "CLP-checkout-cart-1-A1",
    );
    expect(Payment.buildReference("checkout", "cart-1", 2)).toBe(
      "CLP-checkout-cart-1-A2",
    );
  });

  it("distinguishes obligation types so swaps/order-edits never collide with checkout", () => {
    expect(Payment.buildReference("checkout", "cart-1")).not.toBe(
      Payment.buildReference("swap", "cart-1"),
    );
  });

  it("sanitizes obligation ids to a deterministic gateway-safe charset", () => {
    expect(Payment.buildReference("checkout", "cart id!@")).toBe(
      "CLP-checkout-cart-id--",
    );
    expect(Payment.buildReference("checkout", "cart/1?x=1")).toBe(
      "CLP-checkout-cart/1-x=1",
    );
    expect(
      Payment.buildReference("checkout", "cart id!@", 1),
    ).toBe("CLP-checkout-cart-id---A1");
  });
});

describe("Payment entity — DomainError codes", () => {
  it("throws DomainError instances with stable codes", () => {
    let thrown: unknown;
    try {
      new Payment(paymentProps({ amountMinor: 60999 }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).code).toBe("INVALID_PAYMENT_AMOUNT");
  });
});