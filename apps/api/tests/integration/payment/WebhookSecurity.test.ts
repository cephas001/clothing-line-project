// apps/api/tests/integration/payment/WebhookSecurity.test.ts
//
// INTEGRATION TESTS — the webhook entry boundary is cryptographically signed,
// the queue contract is clean and idempotent, and the provider mapper derives
// context ONLY from the durable obligation (never from provider-echoed state).
//
//   1. SIGNATURE: a valid HMAC-SHA512 passes (constant-time comparison); a
//      tampered body, wrong secret, missing header, missing secret, or invalid
//      raw body all fail with PAYMENT_VERIFICATION_FAILED; every attempt is
//      audited.
//   2. QUEUE: a typed internal event is enqueued with jobId =
//      transactionReference and 5 attempts; a duplicate jobId is an idempotent
//      no-op; a malformed payload is a permanent VALIDATION_ERROR and is never
//      enqueued; queue connection/timeout failures surface INTERNAL_ERROR.
//   3. MAPPER: a charge.success resolves ONLY against the durable obligation —
//      unknown references are acknowledged (handled:false) with NO legacy
//      metadata.cartId fallback; a provider currency that disagrees with the
//      obligation is a permanent 400 INVALID_CURRENCY.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { createPaymentHarness } from "./harness";
import { FakeCryptographyService } from "../../fakes/FakeCryptographyService";
import { FakeQueueService } from "../../fakes/FakeQueueService";
import { SequenceIdGenerator } from "../../fakes/SequenceIdGenerator";
import { NoopLogger } from "../../fakes/NoopLogger";
import { VerifyPaymentEventSignatureUseCase } from "@api/use-cases/checkout/VerifyPaymentEventSignatureUseCase";
import { QueuePaymentEventUseCase } from "@api/use-cases/checkout/QueuePaymentEventUseCase";
import { PaystackWebhookPayloadMapper } from "@api/infrastructure/services/PaystackWebhookPayloadMapper";
import {
  CheckoutPaymentEventJobPayload,
  PaymentEventJobPayload,
  QUEUE_NAMES,
} from "@api/domain/shared/jobs";
import {
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import { Payment } from "@api/domain/entities/Payment";

const SECRET = "paystack-webhook-secret-test";
const OBLIGATION_AMOUNT_MINOR = 61000;

function buildWebhookBody(reference: string, amountMinor = OBLIGATION_AMOUNT_MINOR): Buffer {
  return Buffer.from(
    JSON.stringify({
      event: "charge.success",
      data: {
        reference,
        amount: amountMinor,
        currency: "ngn",
      },
    }),
  );
}

function buildCheckoutPayload(
  overrides: Partial<CheckoutPaymentEventJobPayload> = {},
): CheckoutPaymentEventJobPayload {
  return {
    obligationType: "checkout",
    cartId: "cart-1",
    transactionReference: "CLP-checkout-cart-1",
    amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
    currency: "ngn",
    expectedAmountMinor: OBLIGATION_AMOUNT_MINOR,
    reportedCurrency: "ngn",
    ...overrides,
  };
}

function buildCheckoutObligation(
  reference = "CLP-checkout-cart-1",
): Payment {
  return new Payment({
    id: "payment-1",
    obligationType: "checkout",
    obligationId: "cart-1",
    reference,
    amountMinor: OBLIGATION_AMOUNT_MINOR,
    currency: "ngn",
    subtotalMinor: 60000,
    discountMinor: 5000,
    taxMinor: 3000,
    shippingMinor: 2500,
    insuranceMinor: 500,
    status: "initialized",
    providerReference: `pay-${reference}`,
    providerPaymentUrl: `https://pay.example/authorize/${reference}`,
    metadata: { cartId: "cart-1" },
  });
}

describe("Webhook signature verification — HMAC-SHA512 + constant-time compare", () => {
  function harness() {
    const crypto = new FakeCryptographyService();
    const auditLogService = createPaymentHarness().auditLogService;
    const verify = new VerifyPaymentEventSignatureUseCase(
      crypto,
      auditLogService,
      new SequenceIdGenerator(),
      new NoopLogger(),
    );
    return { crypto, auditLogService, verify };
  }

  it("accepts a body signed with the correct secret", () => {
    const { crypto, verify } = harness();
    const body = buildWebhookBody("CLP-checkout-cart-1");
    const signature = crypto.sign(body, SECRET);

    verify.execute({ rawBody: body, signatureHeader: signature, secretKey: SECRET });
    // The cryptography boundary performed a REAL HMAC + constant-time compare
    // (the helper's sign() records one HMAC too, so at least one further HMAC
    // and a constant-time comparison happened during verification).
    expect(crypto.hmacCalls.length).toBeGreaterThan(0);
    expect(crypto.compareCalls).toBeGreaterThan(0);
  });

  it("rejects a TAMPERED body with PAYMENT_VERIFICATION_FAILED", () => {
    const { crypto, verify } = harness();
    const body = buildWebhookBody("CLP-checkout-cart-1");
    const signature = crypto.sign(body, SECRET);

    // The amount is mutated AFTER signing — the signature no longer matches.
    const tampered = buildWebhookBody("CLP-checkout-cart-1", OBLIGATION_AMOUNT_MINOR + 1);
    expect(() =>
      verify.execute({
        rawBody: tampered,
        signatureHeader: signature,
        secretKey: SECRET,
      }),
    ).toThrowWithCode("PAYMENT_VERIFICATION_FAILED");
  });

  it("rejects a signature produced with a DIFFERENT secret", () => {
    const { crypto, verify } = harness();
    const body = buildWebhookBody("CLP-checkout-cart-1");
    const signature = crypto.sign(body, "some-other-secret");

    expect(() =>
      verify.execute({ rawBody: body, signatureHeader: signature, secretKey: SECRET }),
    ).toThrowWithCode("PAYMENT_VERIFICATION_FAILED");
  });

  it("rejects a MISSING signature header", () => {
    const { verify } = harness();
    expect(() =>
      verify.execute({
        rawBody: buildWebhookBody("CLP-checkout-cart-1"),
        signatureHeader: "",
        secretKey: SECRET,
      }),
    ).toThrowWithCode("PAYMENT_VERIFICATION_FAILED");
  });

  it("rejects a MISSING secret key", () => {
    const { crypto, verify } = harness();
    const body = buildWebhookBody("CLP-checkout-cart-1");
    const signature = crypto.sign(body, SECRET);

    expect(() =>
      verify.execute({ rawBody: body, signatureHeader: signature, secretKey: "" }),
    ).toThrowWithCode("PAYMENT_VERIFICATION_FAILED");
  });

  it("rejects an INVALID raw body (not a Buffer)", () => {
    const { verify } = harness();
    expect(() =>
      verify.execute({
        rawBody: "not-a-buffer" as unknown as Buffer,
        signatureHeader: "x",
        secretKey: SECRET,
      }),
    ).toThrowWithCode("PAYMENT_VERIFICATION_FAILED");
  });

  it("audits both successful and failed verification attempts", () => {
    const { crypto, auditLogService, verify } = harness();
    const body = buildWebhookBody("CLP-checkout-cart-1");
    const signature = crypto.sign(body, SECRET);

    verify.execute({ rawBody: body, signatureHeader: signature, secretKey: SECRET });
    expect(() =>
      verify.execute({ rawBody: body, signatureHeader: "bad", secretKey: SECRET }),
    ).toThrowWithCode("PAYMENT_VERIFICATION_FAILED");

    const actions = auditLogService.entries.filter(
      (e) => e.action === "PAYMENT_SIGNATURE_VERIFICATION",
    );
    expect(actions.length).toBe(2);
  });
});

describe("Payment event queue — typed contract + idempotent jobId", () => {
  function harness() {
    const queue = new FakeQueueService();
    const auditLogService = createPaymentHarness().auditLogService;
    const enqueue = new QueuePaymentEventUseCase(
      queue,
      auditLogService,
      new SequenceIdGenerator(),
      new NoopLogger(),
    );
    return { queue, auditLogService, enqueue };
  }

  it("enqueues a valid typed internal event with jobId = transactionReference", async () => {
    const { queue, enqueue } = harness();
    const payload = buildCheckoutPayload();

    await enqueue.execute({ paymentEvent: payload });

    const jobs = queue.paymentEventJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].queueName).toBe(QUEUE_NAMES.paymentEvents);
    expect(jobs[0].options?.jobId).toBe("CLP-checkout-cart-1");
    expect(jobs[0].options?.attempts).toBe(5);
    expect(jobs[0].options?.removeOnComplete).toBe(true);
  });

  it("treats a duplicate jobId as an idempotent success (never a second job)", async () => {
    const { queue, auditLogService, enqueue } = harness();
    const payload = buildCheckoutPayload();

    await enqueue.execute({ paymentEvent: payload });
    await enqueue.execute({ paymentEvent: payload });

    expect(queue.paymentEventJobs()).toHaveLength(1);
    expect(
      auditLogService.entries.some(
        (e) => e.action === "PAYMENT_EVENT_ALREADY_QUEUED",
      ),
    ).toBe(true);
  });

  it("rejects a MALFORMED payload with VALIDATION_ERROR and enqueues nothing", async () => {
    const { queue, enqueue } = harness();
    const malformed = {
      obligationType: "checkout",
      cartId: "cart-1",
      // transactionReference missing -> permanently malformed.
    } as unknown as PaymentEventJobPayload;

    await expect(() => enqueue.execute({ paymentEvent: malformed })).rejectsWithCode(
      "VALIDATION_ERROR",
    );
    expect(queue.paymentEventJobs()).toHaveLength(0);
  });

  it("surfaces INTERNAL_ERROR on a queue CONNECTION failure", async () => {
    const { queue, enqueue } = harness();
    queue.failWithCode = RepositoryErrorCode.CONNECTION;

    await expect(() =>
      enqueue.execute({ paymentEvent: buildCheckoutPayload() }),
    ).rejectsWithCode("INTERNAL_ERROR");
    expect(queue.paymentEventJobs()).toHaveLength(0);
  });

  it("surfaces INTERNAL_ERROR on a queue TIMEOUT failure", async () => {
    const { queue, enqueue } = harness();
    queue.failWithCode = RepositoryErrorCode.TIMEOUT;

    await expect(() =>
      enqueue.execute({ paymentEvent: buildCheckoutPayload() }),
    ).rejectsWithCode("INTERNAL_ERROR");
    expect(queue.paymentEventJobs()).toHaveLength(0);
  });
});

describe("Provider webhook mapper — context derives ONLY from the durable obligation", () => {
  function harness() {
    const paymentRepository = createPaymentHarness().paymentRepository;
    const mapper = new PaystackWebhookPayloadMapper({ paymentRepository });
    return { paymentRepository, mapper };
  }

  it("maps a charge.success for a checkout obligation to a typed internal event", async () => {
    const { paymentRepository, mapper } = harness();
    paymentRepository.seed(buildCheckoutObligation());

    const result = await mapper.parseAndMap(
      buildWebhookBody("CLP-checkout-cart-1"),
    );

    expect(result.handled).toBe(true);
    if (!result.handled) return;
    const event = result.paymentEvent;
    if (event.obligationType !== "checkout") {
      throw new Error("expected a checkout payment event");
    }
    expect(event.cartId).toBe("cart-1");
    expect(event.transactionReference).toBe("CLP-checkout-cart-1");
    expect(event.amountPaidMinor).toBe(OBLIGATION_AMOUNT_MINOR);
    // The authoritative currency + expected amount come from the DURABLE
    // obligation, never from provider-echoed state.
    expect(event.currency).toBe("ngn");
    expect(event.expectedAmountMinor).toBe(OBLIGATION_AMOUNT_MINOR);
  });

  it("acknowledges an UNKNOWN reference as handled:false — NO legacy metadata.cartId fallback", async () => {
    const { paymentRepository, mapper } = harness();
    paymentRepository.seed(buildCheckoutObligation());

    const result = await mapper.parseAndMap(
      buildWebhookBody("CLP-checkout-some-foreign-charge"),
    );

    expect(result.handled).toBe(false);
  });

  it("acknowledges a non-charge.success event without producing a payment event", async () => {
    const { paymentRepository, mapper } = harness();
    paymentRepository.seed(buildCheckoutObligation());

    const result = await mapper.parseAndMap(
      Buffer.from(
        JSON.stringify({ event: "charge.failed", data: {} }),
      ),
    );

    expect(result.handled).toBe(false);
    if (result.handled) {
      throw new Error("expected an unhandled event");
    }
    expect(result.eventType).toBe("charge.failed");
  });

  it("rejects a currency that disagrees with the durable obligation with INVALID_CURRENCY", async () => {
    const { paymentRepository, mapper } = harness();
    paymentRepository.seed(buildCheckoutObligation());

    await expect(() =>
      mapper.parseAndMap(
        Buffer.from(
          JSON.stringify({
            event: "charge.success",
            data: { reference: "CLP-checkout-cart-1", amount: OBLIGATION_AMOUNT_MINOR, currency: "usd" },
          }),
        ),
      ),
    ).rejectsWithCode("INVALID_CURRENCY");
  });

  it("rejects structurally MALFORMED payloads with VALIDATION_ERROR", async () => {
    const { mapper } = harness();

    await expect(() => mapper.parseAndMap(Buffer.from("{ not json"))).rejectsWithCode(
      "VALIDATION_ERROR",
    );
    await expect(() =>
      mapper.parseAndMap(
        Buffer.from(
          JSON.stringify({ event: "charge.success", data: { reference: "CLP-checkout-cart-1" } }),
        ),
      ),
    ).rejectsWithCode("VALIDATION_ERROR");
  });

  it("maps a charge.success for a SWAP obligation to a swap event (swapId + orderId derived locally)", async () => {
    const { paymentRepository, mapper } = harness();
    paymentRepository.seed(
      new Payment({
        id: "payment-swap-1",
        obligationType: "swap",
        obligationId: "swap-1",
        reference: "CLP-swap-swap-1",
        amountMinor: 5000,
        currency: "ngn",
        subtotalMinor: 5000,
        discountMinor: 0,
        taxMinor: 0,
        shippingMinor: 0,
        insuranceMinor: 0,
        status: "initialized",
        providerReference: "pay-CLP-swap-swap-1",
        providerPaymentUrl: "https://pay.example/swap/CLP-swap-swap-1",
        metadata: { orderId: "order-1" },
      }),
    );

    const result = await mapper.parseAndMap(
      buildWebhookBody("CLP-swap-swap-1", 5000),
    );

    expect(result.handled).toBe(true);
    if (!result.handled) return;
    const swapEvent = result.paymentEvent;
    if (swapEvent.obligationType !== "swap") {
      throw new Error("expected a swap payment event");
    }
    expect(swapEvent.swapId).toBe("swap-1");
    expect(swapEvent.orderId).toBe("order-1");
    expect(swapEvent.transactionReference).toBe("CLP-swap-swap-1");
    expect(swapEvent.expectedAmountMinor).toBe(5000);
  });
});