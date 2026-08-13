// apps/api/src/domain/entities/Payment.ts

// Durable payment obligation/intent record. The payment flow creates ONE
// Payment per obligation (a checkout cart, a swap upcharge, an order-edit
// due) with an application-generated `reference` that is passed to the
// payment gateway up front, so the same request always resolves to the same
// obligation row and the same gateway reference.
//
// Idempotency is backstopped by the database: `payment.reference` and
// `payment.provider_reference` are UNIQUE, and (obligation_type,
// obligation_id) is UNIQUE, so a concurrent or retried initialization collides
// instead of double-charging. The entity is a pure domain model — it never
// touches repositories, gateways, loggers, or databases.

import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { PaymentAmountBreakdown } from "@api/domain/shared/contracts";
import { JsonObject } from "@api/domain/shared/json";

/** The kind of business object a payment settles. */
export type PaymentObligationType = "checkout" | "swap" | "order_edit";

/**
 * Lifecycle of a durable payment obligation.
 *
 * - `initialization_pending` — the obligation has been durably claimed in the
 *   database but the gateway has NOT yet confirmed acceptance. PostgreSQL
 *   transactions cannot span the external gateway HTTP call, so this explicit
 *   state separates "claimed" from "accepted". A crash here leaves a pending
 *   obligation that replay re-initializes with the same deterministic reference
 *   (idempotent).
 * - `initialized` — the gateway accepted the intent and the provider
 *   authorization URL is durably recorded. INVARIANT: a payment is
 *   `initialized` if and only if it carries a provider payment URL.
 * - `captured`, `failed`, `refunded`, `partially_refunded` — settled states.
 */
export type PaymentState =
  | "initialization_pending"
  | "initialized"
  | "captured"
  | "failed"
  | "refunded"
  | "partially_refunded";

export interface PaymentProps {
  id: string;
  obligationType: PaymentObligationType;
  obligationId: string;
  /** App-generated idempotency reference; unique and passed to the gateway. */
  reference: string;
  /** Provider (gateway) transaction reference; set once initialization returns. */
  providerReference?: string | null;
  /** Provider authorization URL the customer is redirected to. */
  providerPaymentUrl?: string | null;
  /**
   * The single authoritative charge amount in integer minor units (Kobo/cents).
   * For checkout obligations this equals `breakdown.totalMinor` and is what the
   * gateway is asked to capture and what the webhook must match.
   */
  amountMinor: number;
  /**
   * ISO-4217 currency code (lowercase). REQUIRED for checkout obligations; the
   * webhook pipeline verifies the provider's reported currency against this.
   */
  currency?: string | null;
  /** Server-computed subtotal (Σ line totals) in minor units. */
  subtotalMinor?: number;
  /** Server-computed promotion discount in minor units. */
  discountMinor?: number;
  /** Server-computed regional tax in minor units. */
  taxMinor?: number;
  /** Selected shipping amount in minor units. */
  shippingMinor?: number;
  /** Embedded insurance premium in minor units. */
  insuranceMinor?: number;
  status?: PaymentState;
  metadata?: JsonObject;
  createdAt?: string;
  updatedAt?: string;
}

export class Payment {
  readonly id: string;
  readonly obligationType: PaymentObligationType;
  readonly obligationId: string;
  readonly reference: string;
  readonly amountMinor: number; // Integer minor units (Kobo)
  readonly currency: string | null;
  readonly createdAt: string;

  /** Server-computed subtotal (Σ line totals) in minor units. */
  readonly subtotalMinor: number;
  /** Server-computed promotion discount in minor units. */
  readonly discountMinor: number;
  /** Server-computed regional tax in minor units. */
  readonly taxMinor: number;
  /** Selected shipping amount in minor units. */
  readonly shippingMinor: number;
  /** Embedded insurance premium in minor units. */
  readonly insuranceMinor: number;

  public providerReference: string | null;
  public providerPaymentUrl: string | null;
  public metadata: JsonObject;
  public updatedAt: string;

  private _status: PaymentState;

  constructor(props: PaymentProps) {
    if (!props.id || props.id.trim() === "") {
      throw new DomainError("VALIDATION_ERROR", "Payment id is required.");
    }
    if (!props.obligationType) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Payment must declare its obligation type.",
      );
    }
    if (!props.obligationId || props.obligationId.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Payment must reference its obligation id.",
      );
    }
    if (!props.reference || props.reference.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Payment must carry a unique idempotency reference.",
      );
    }
    if (!Number.isInteger(props.amountMinor) || props.amountMinor <= 0) {
      throw new DomainError(
        "NEGATIVE_AMOUNT",
        "Payment amount must be a strictly positive integer in minor units.",
      );
    }

    // --- Authoritative financial breakdown (money/currency integrity) --------
    // Checkout obligations always carry a currency; legacy/pre-foundation rows
    // (and non-checkout obligations) may be null. `amountMinor` must equal the
    // sum of the server-computed parts so the durable obligation is internally
    // consistent and never relies on "today's price" to reconstruct what was
    // charged.
    const subtotalMinor = props.subtotalMinor ?? props.amountMinor;
    const discountMinor = props.discountMinor ?? 0;
    const taxMinor = props.taxMinor ?? 0;
    const shippingMinor = props.shippingMinor ?? 0;
    const insuranceMinor = props.insuranceMinor ?? 0;

    for (const [label, value] of [
      ["subtotalMinor", subtotalMinor],
      ["discountMinor", discountMinor],
      ["taxMinor", taxMinor],
      ["shippingMinor", shippingMinor],
      ["insuranceMinor", insuranceMinor],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new DomainError(
          "NEGATIVE_AMOUNT",
          `Payment ${label} must be a non-negative integer in minor units.`,
        );
      }
    }
    if (discountMinor > subtotalMinor) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Payment discount cannot exceed the subtotal.",
      );
    }
    const computedTotal =
      subtotalMinor - discountMinor + taxMinor + shippingMinor + insuranceMinor;
    if (props.amountMinor !== computedTotal) {
      throw new DomainError(
        "INVALID_PAYMENT_AMOUNT",
        `Payment amount (${props.amountMinor}) does not match the authoritative breakdown (${computedTotal}).`,
      );
    }

    // --- Lifecycle integrity ------------------------------------------------
    // A newly constructed obligation defaults to INITIALIZATION_PENDING: the
    // gateway has not been contacted yet, so the payment must NOT claim to be
    // initialized. Enforce the invariant that `initialized` implies a provider
    // payment URL exists — this is exactly the transactional-consistency state
    // that prevents "Paystack accepted but our database lost the result".
    const status = props.status ?? "initialization_pending";
    if (status === "initialized" && !props.providerPaymentUrl) {
      throw new DomainError(
        "INVALID_STATE",
        "A payment cannot be initialized without a provider payment URL.",
      );
    }

    this.id = props.id;
    this.obligationType = props.obligationType;
    this.obligationId = props.obligationId;
    this.reference = props.reference;
    this.amountMinor = props.amountMinor;
    this.currency = props.currency ?? null;
    this.subtotalMinor = subtotalMinor;
    this.discountMinor = discountMinor;
    this.taxMinor = taxMinor;
    this.shippingMinor = shippingMinor;
    this.insuranceMinor = insuranceMinor;
    this._status = status;
    this.providerReference = props.providerReference ?? null;
    this.providerPaymentUrl = props.providerPaymentUrl ?? null;
    this.metadata = props.metadata ?? {};
    this.createdAt = props.createdAt ?? new Date().toISOString();
    this.updatedAt = props.updatedAt ?? this.createdAt;
  }

  /** The authoritative financial breakdown this obligation records. */
  get breakdown(): PaymentAmountBreakdown {
    return {
      subtotalMinor: this.subtotalMinor,
      discountMinor: this.discountMinor,
      taxMinor: this.taxMinor,
      shippingMinor: this.shippingMinor,
      insuranceMinor: this.insuranceMinor,
      totalMinor: this.amountMinor,
    };
  }

  /**
   * Record that the gateway accepted the payment intent, transitioning the
   * obligation from `initialization_pending` (or a failed/retried state) to
   * `initialized`. `providerPaymentUrl` is required; `providerReference` is the
   * provider's authoritative reference and is persisted when returned. Cannot
   * re-initialize a settled payment. After this call the payment is durably
   * re-persisted, so the DB never shows "Paystack accepted" without the
   * matching provider URL/reference.
   */
  markInitialized(props: {
    providerReference?: string | null;
    providerPaymentUrl: string;
  }): void {
    if (
      this._status === "captured" ||
      this._status === "refunded" ||
      this._status === "partially_refunded"
    ) {
      throw new DomainError(
        "INVALID_STATE",
        "Cannot re-initialize a payment that has already settled.",
      );
    }
    this._status = "initialized";
    if (props.providerReference && props.providerReference.trim() !== "") {
      this.providerReference = props.providerReference.trim();
    }
    this.providerPaymentUrl = props.providerPaymentUrl;
    this.updatedAt = new Date().toISOString();
  }

  /** True while the obligation is claimed but the gateway has not accepted it. */
  isInitializationPending(): boolean {
    return this._status === "initialization_pending";
  }

  /**
   * Mark the payment as captured (the charge settled). Idempotent for an
   * already-captured payment; never captures a refunded payment.
   */
  markCaptured(): void {
    if (this._status === "captured") {
      return;
    }
    if (this._status === "refunded" || this._status === "partially_refunded") {
      throw new DomainError("INVALID_STATE", "Cannot capture a refunded payment.");
    }
    this._status = "captured";
    this.updatedAt = new Date().toISOString();
  }

  /** Mark the payment as failed (gateway rejection / unrecoverable error). */
  markFailed(): void {
    if (this._status === "captured" || this._status === "refunded") {
      throw new DomainError("INVALID_STATE", "Cannot fail a settled payment.");
    }
    this._status = "failed";
    this.updatedAt = new Date().toISOString();
  }

  /**
   * Mark the payment as refunded (full or partial). Only captured payments can
   * be refunded; a partially refunded payment keeps accepting further refunds.
   */
  markRefunded(partial: boolean): void {
    if (this._status !== "captured") {
      throw new DomainError(
        "INVALID_STATE",
        "Only captured payments can be refunded.",
      );
    }
    this._status = partial ? "partially_refunded" : "refunded";
    this.updatedAt = new Date().toISOString();
  }

  get status(): PaymentState {
    return this._status;
  }

  /**
   * Build the deterministic, gateway-safe idempotency reference for a payment
   * obligation. Derived from the obligation identity so retries of the same
   * request always produce the same reference. Restricted to the charset
   * Paystack accepts on /transaction/initialize (alphanumeric, `-`, `.`, `=`).
   */
  static buildReference(
    obligationType: PaymentObligationType,
    obligationId: string,
  ): string {
    const safeType = obligationType.replace(/[^A-Za-z0-9.-]/g, "-");
    const safeId = obligationId.replace(/[^A-Za-z0-9.-=]/g, "-");
    return `CLP-${safeType}-${safeId}`;
  }
}