// apps/api/src/infrastructure/services/PaystackWebhookPayloadMapper.ts

// Provider-specific adapter that translates an incoming Paystack webhook POST
// into the provider-agnostic `PaymentEventJobPayload` the domain queue contract
// expects. This is the explicit mapping function at the application/infrastructure
// boundary: it is the ONLY module that knows Paystack's webhook event shape, and
// no Paystack structure ever reaches the queue contract or the worker.
//
// Responsibilities:
// - parseAndMap: parse the RAW request body (already signature-verified by the
//   controller) as JSON and validate the provider envelope.
// - Resolve the corresponding LOCAL payment obligation using the established
//   payment reference mapping (IPaymentRepository.findByReference /
//   findByProviderReference): the webhook reference is echoed from the reference
//   the app supplied at initialization, so it identifies the durable Payment
//   row, and for a checkout obligation the payment's obligationId IS the cartId.
//   The cartId is therefore derived from local authoritative state, never from
//   provider-echoed metadata.
// - Return either
//   * `{ handled: true, paymentEvent }` for a `charge.success` whose obligation
//     resolves to a checkout cart or a swap upcharge, or
//   * `{ handled: false, eventType }` for well-formed events that are not
//     finalizable orders: other event types, non-checkout/non-swap obligations,
//     or references that resolve to NO durable obligation (legacy/foreign
//     charges). Unhandled events are acknowledged by the controller (HTTP 200)
//     so the gateway stops retrying, without producing queue noise. An unknown
//     reference is NEVER mapped to a checkout event — there is no legacy
//     `metadata.cartId` fallback.
// - Structurally malformed payloads (invalid JSON, missing event/data,
//   missing reference/amount, non-integer amount) THROW a VALIDATION_ERROR
//   DomainError, which the controller maps to HTTP 400 (a permanent failure the
//   gateway should not retry).
//
// Mapping rules (provider -> internal):
//   data.reference        -> transactionReference (the app-supplied reference is
//                            echoed by Paystack and is the idempotency key)
//   data.amount           -> amountPaidMinor (Paystack amounts are already
//                            integer minor units; no conversion is applied)
//   data.currency         -> reportedCurrency (preserved verbatim so the worker
//                            can verify it against the obligation)
//   resolved payment      -> cartId (obligationId when obligationType ===
//                            "checkout") or swapId/orderId (when "swap"), both
//                            derived from the DURABLE obligation, NEVER from
//                            provider-echoed metadata; expectedAmountMinor +
//                            authoritative currency come from the DURABLE
//                            obligation, never from the webhook.
//
// The queue contract stays clean: `PaymentEventJobPayload` is provider-agnostic
// and the PaymentEventWorker consumes it directly. A valid signature is NOT
// sufficient — the worker re-verifies reference/context/amount/currency/state
// against the durable obligation (VerifyPaymentEventUseCase) before any
// financial finalization.

import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { IPaymentRepository } from "@api/domain/interfaces/repositories/IPaymentRepository";
import type { PaymentEventJobPayload } from "@api/domain/shared/jobs";

/** The only Paystack event type this pipeline processes. */
export const PAYSTACK_CHARGE_SUCCESS_EVENT = "charge.success";

export type PaystackWebhookParseResult =
  | { handled: true; paymentEvent: PaymentEventJobPayload }
  | { handled: false; eventType: string };

export interface PaystackWebhookPayloadMapperDeps {
  /** Established payment reference mapping used to resolve the local obligation. */
  paymentRepository: IPaymentRepository;
}

export class PaystackWebhookPayloadMapper {
  constructor(private readonly deps: PaystackWebhookPayloadMapperDeps) {}

  /**
   * Parse and map a signature-verified raw webhook body. Returns a handled or
   * ignored result; throws VALIDATION_ERROR for structurally invalid payloads.
   */
  async parseAndMap(rawBody: Buffer): Promise<PaystackWebhookParseResult> {
    const envelope = parseJsonEnvelope(rawBody);
    const event = requireString(envelope.event, "event");
    const data = requireObject(envelope.data, "data");

    // Only successful charges are relevant to order finalization. Any other
    // event is acknowledged (handled: false) rather than rejected, so the
    // gateway stops retrying it.
    if (event !== PAYSTACK_CHARGE_SUCCESS_EVENT) {
      return { handled: false, eventType: event };
    }

    const transactionReference = requireString(
      data.reference,
      "data.reference",
    );
    const amountPaidMinor = requireMinorAmount(data.amount);
    const reportedCurrency = readOptionalString(data.currency);

    // Resolve the LOCAL payment obligation by reference. The webhook reference
    // is echoed from what the app supplied at initialization, so it matches the
    // durable payment's app reference first, then its provider reference.
    const payment =
      (await this.deps.paymentRepository.findByReference(
        transactionReference,
      )) ??
      (await this.deps.paymentRepository.findByProviderReference(
        transactionReference,
      ));

    // A checkout payment's obligationId IS the cart being settled — derived
    // from local authoritative state, not provider-echoed metadata.
    if (payment && payment.obligationType === "checkout") {
      const cartId = payment.obligationId.trim();
      if (!cartId) {
        return { handled: false, eventType: event };
      }

      // Money/currency integrity: when the provider reports a currency it must
      // agree with the DURABLE obligation's currency. A mismatch is a permanent
      // VALIDATION_ERROR (HTTP 400) — the event must never be processed against
      // a different currency obligation.
      if (
        reportedCurrency &&
        payment.currency &&
        reportedCurrency.toLowerCase() !== payment.currency.toLowerCase()
      ) {
        throw new DomainError(
          "INVALID_CURRENCY",
          "Webhook currency does not match the payment obligation currency.",
        );
      }

      return {
        handled: true,
        paymentEvent: {
          obligationType: "checkout",
          cartId,
          transactionReference,
          amountPaidMinor,
          // The authoritative currency + expected amount come from the DURABLE
          // obligation, never from provider-echoed state. `reportedCurrency`
          // preserves the provider-reported value so the worker's financial
          // verification can compare it against the obligation independently.
          currency: payment.currency,
          expectedAmountMinor: payment.amountMinor,
          reportedCurrency: reportedCurrency ?? null,
        },
      };
    }

    // A swap-upcharge payment's obligationId IS the swap id, and its order is
    // recorded on the durable obligation's metadata at claim time — both derived
    // from local authoritative state, never from provider-echoed metadata. The
    // worker re-verifies them against the swap row (VerifySwapPaymentEventUseCase).
    if (payment && payment.obligationType === "swap") {
      const swapId = payment.obligationId.trim();
      const orderId = readOptionalString(
        isRecord(payment.metadata) ? payment.metadata.orderId : undefined,
      );
      if (!swapId || !orderId) {
        return { handled: false, eventType: event };
      }

      // Money/currency integrity: the provider-reported currency must agree
      // with the DURABLE obligation's frozen currency. A mismatch is a
      // permanent VALIDATION_ERROR (HTTP 400) — the event must never be
      // processed against a different currency obligation.
      if (
        reportedCurrency &&
        payment.currency &&
        reportedCurrency.toLowerCase() !== payment.currency.toLowerCase()
      ) {
        throw new DomainError(
          "INVALID_CURRENCY",
          "Webhook currency does not match the payment obligation currency.",
        );
      }

      return {
        handled: true,
        paymentEvent: {
          obligationType: "swap",
          swapId,
          orderId,
          transactionReference,
          amountPaidMinor,
          currency: payment.currency,
          expectedAmountMinor: payment.amountMinor,
          reportedCurrency: reportedCurrency ?? null,
        },
      };
    }

    // No local payment obligation resolves for this reference. Under the
    // "every payable webhook MUST resolve to a durable payment obligation"
    // invariant there is NO legacy metadata fallback: a charge.success that
    // resolves to no checkout/swap obligation (foreign charge, order-edit due,
    // stale/unknown reference) is well-formed but NOT something this pipeline
    // can finalize. It is acknowledged (handled: false) so the gateway stops
    // retrying, and no event is queued — nothing can be verified or finalized
    // against a nonexistent obligation.
    return { handled: false, eventType: event };
  }
}

// ---------------------------------------------------------------------------
// Module-local validation helpers (kept private; no Paystack types leak out)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonEnvelope(rawBody: Buffer): Record<string, unknown> {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Webhook request body is empty.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Webhook payload is not valid JSON.",
    );
  }
  if (!isRecord(parsed)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Webhook payload must be a JSON object.",
    );
  }
  return parsed;
}

function requireString(value: unknown, field: string): string {
  const trimmed = readOptionalString(value);
  if (!trimmed) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Webhook payload field '${field}' is required and must be a non-empty string.`,
    );
  }
  return trimmed;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function requireObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Webhook payload field '${field}' must be an object.`,
    );
  }
  return value;
}

function requireMinorAmount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Webhook payload field 'data.amount' must be a non-negative integer in minor units.",
    );
  }
  return value;
}
