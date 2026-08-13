// apps/api/src/domain/interfaces/services/IPaymentService.ts

/**
 * Contract for the payment gateway adapter. The application layer depends only
 * on this abstraction; concrete adapters (e.g. PaystackPaymentService) live in
 * infrastructure and never query repositories.
 *
 * Money and reference integrity:
 * - The amount, currency, and reference the gateway sees come from a DURABLE
 *   payment obligation that the application computed and persisted BEFORE the
 *   adapter is invoked. The adapter forwards these values verbatim — it NEVER
 *   recalculates an amount, currency, or reference from carts, prices, or the
 *   obligation id.
 * - `initializeCheckoutTransaction` receives a typed `CheckoutPaymentObligation`
 *   and `initializeSwapPayment` receives a typed `SwapPaymentObligation`, so the
 *   exact authoritative fields (amountMinor, currency, reference, email) are
 *   structural, not ad-hoc, for both flows.
 *
 * Idempotency contract: callers supply a deterministic `reference` in the
 * initialize payloads. The adapter preserves it exactly when the gateway
 * accepts it and returns the provider's authoritative reference so the
 * application can persist it durably. Refunds return the provider's refund
 * reference so the application can record dispatch.
 */
import type { JsonObject } from "@api/domain/shared/json";

/**
 * The authoritative, durable payment obligation for a checkout. Carries ONLY
 * fields the application computed and persisted BEFORE the gateway is
 * contacted (authoritative checkout calculation -> durable payment obligation
 * -> Paystack initialization). The adapter must use exactly these values.
 */
export interface CheckoutPaymentObligation {
  /**
   * The single authoritative charge amount in integer minor units
   * (Kobo/cents). Equals `payment.amountMinor` / `breakdown.totalMinor`; the
   * adapter never derives or recalculates it.
   */
  amountMinor: number;
  /**
   * ISO-4217 currency code (lowercase) of the charge, from the durable
   * obligation (`payment.currency`), not from a region or cart lookup.
   */
  currency: string;
  /**
   * Deterministic application idempotency reference, from the durable
   * obligation (`payment.reference`). Forwarded verbatim; retries of the same
   * obligation always hit the same gateway transaction.
   */
  reference: string;
  /** Customer email required by the gateway on /transaction/initialize. */
  email: string;
  /** Optional redirect hint for the gateway's callback_url. */
  returnUrl?: string | null;
  /** Opaque metadata echoed back by the gateway. */
  metadata?: JsonObject | null;
}

/**
 * The authoritative, durable payment obligation for a swap upcharge. Carries
 * ONLY fields the application computed and persisted BEFORE the gateway is
 * contacted (authoritative swap variance -> durable swap payment obligation ->
 * Paystack initialization). The adapter must use exactly these values.
 */
export interface SwapPaymentObligation {
  /**
   * The single authoritative upcharge amount in integer minor units
   * (Kobo/cents). Equals `payment.amountMinor` / the swap `differenceMinor`;
   * the adapter never derives or recalculates it.
   */
  amountMinor: number;
  /**
   * ISO-4217 currency code (lowercase) of the charge, from the durable
   * obligation (`payment.currency`), frozen from the order's currency at claim
   * time — never inferred from a region or cart lookup.
   */
  currency: string;
  /**
   * Deterministic application idempotency reference, from the durable
   * obligation (`payment.reference`). Forwarded verbatim; retries of the same
   * obligation always hit the same gateway transaction.
   */
  reference: string;
  /** Customer email required by the gateway on /transaction/initialize. */
  email: string;
  /** Optional redirect hint for the gateway's callback_url. */
  returnUrl?: string | null;
  /** Opaque metadata echoed back by the gateway. */
  metadata?: JsonObject | null;
}

export interface IPaymentService {
  /**
   * Initialize a CHECKOUT payment transaction from the authoritative durable
   * obligation. `amountMinor`, `currency`, and `reference` are taken verbatim
   * from the obligation (never recalculated). Returns the customer-facing
   * authorization URL and the provider's authoritative transaction reference
   * so the application can persist it durably.
   */
  initializeCheckoutTransaction(
    obligation: CheckoutPaymentObligation,
  ): Promise<{ authorizationUrl: string; providerReference: string | null }>;
  /** Local compensation hook invoked best-effort after a persistence failure. */
  cancelInitialization(payload: Record<string, unknown>): Promise<void>;
  initializeSwapPayment(
    obligation: SwapPaymentObligation,
  ): Promise<{ authorizationUrl: string; providerReference: string | null }>;
  issueRefund(
    transactionReference: string,
    amountMinor: number,
    payload: Record<string, unknown>,
  ): Promise<{ providerRefundReference: string | null }>;
  cancelTransaction(transactionReference: string): Promise<void>;
}
