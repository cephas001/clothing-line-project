// apps/api/src/domain/entities/Refund.ts

// Durable, idempotent refund record. A refund is uniquely identified by
// (provider_transaction_reference, amount_minor) in the database so the same
// refund request can never be issued twice, plus an application-generated
// `refundReference` and the provider's refund reference once dispatched.
//
// The entity is a pure domain model — it never touches repositories, gateways,
// loggers, or databases. Financial-integrity rule: an ambiguous refund (claimed
// but never confirmed as dispatched) must NOT be automatically re-issued; the
// caller surfaces a reconciliation-required outcome instead.

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { JsonObject } from "@api/domain/shared/json";

export type RefundStatus = "pending" | "dispatched" | "failed";

export interface RefundProps {
  id: string;
  /** Optional link to the original payment intent (NULL for legacy rows). */
  paymentId?: string | null;
  /** App-generated idempotency reference; unique. */
  refundReference: string;
  /** Provider (gateway) refund reference; set once dispatch is confirmed. */
  providerRefundReference?: string | null;
  /** The provider transaction this refund targets. */
  providerTransactionReference: string;
  /** Refund amount in integer minor units (Kobo/cents). */
  amountMinor: number;
  currency?: string | null;
  status?: RefundStatus;
  reason?: string | null;
  metadata?: JsonObject;
  createdAt?: string;
  updatedAt?: string;
}

export class Refund {
  readonly id: string;
  readonly paymentId: string | null;
  readonly refundReference: string;
  readonly providerTransactionReference: string;
  readonly amountMinor: number; // Integer minor units (Kobo)
  readonly currency: string | null;
  readonly reason: string | null;
  readonly createdAt: string;

  public providerRefundReference: string | null;
  public metadata: JsonObject;
  public updatedAt: string;

  private _status: RefundStatus;

  constructor(props: RefundProps) {
    if (!props.id || props.id.trim() === "") {
      throw new DomainError("VALIDATION_ERROR", "Refund id is required.");
    }
    if (!props.refundReference || props.refundReference.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Refund must carry a unique idempotency reference.",
      );
    }
    if (
      !props.providerTransactionReference ||
      props.providerTransactionReference.trim() === ""
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Refund must reference the provider transaction it targets.",
      );
    }
    if (!Number.isInteger(props.amountMinor) || props.amountMinor <= 0) {
      throw new DomainError(
        "NEGATIVE_AMOUNT",
        "Refund amount must be a strictly positive integer in minor units.",
      );
    }

    this.id = props.id;
    this.paymentId = props.paymentId ?? null;
    this.refundReference = props.refundReference;
    this.providerTransactionReference = props.providerTransactionReference;
    this.amountMinor = props.amountMinor;
    this.currency = props.currency ?? null;
    this._status = props.status ?? "pending";
    this.providerRefundReference = props.providerRefundReference ?? null;
    this.reason = props.reason ?? null;
    this.metadata = props.metadata ?? {};
    this.createdAt = props.createdAt ?? new Date().toISOString();
    this.updatedAt = props.updatedAt ?? this.createdAt;
  }

  /**
   * Record that the gateway confirmed the refund. Only a pending refund can be
   * dispatched; the provider's refund reference is persisted when returned.
   */
  markDispatched(props: { providerRefundReference?: string | null }): void {
    if (this._status !== "pending") {
      throw new DomainError(
        "INVALID_STATE",
        "Only pending refunds can be dispatched.",
      );
    }
    this._status = "dispatched";
    if (props.providerRefundReference && props.providerRefundReference.trim() !== "") {
      this.providerRefundReference = props.providerRefundReference.trim();
    }
    this.updatedAt = new Date().toISOString();
  }

  /** Record that the gateway rejected the refund (no blind retry). */
  markFailed(reason?: string): void {
    if (this._status === "dispatched") {
      throw new DomainError("INVALID_STATE", "Dispatched refunds cannot be failed.");
    }
    this._status = "failed";
    this.updatedAt = new Date().toISOString();
  }

  get status(): RefundStatus {
    return this._status;
  }

  /**
   * Build the deterministic refund idempotency reference from the provider
   * transaction and the refunded amount, so retries of the same refund request
   * always produce the same reference. Charset-safe (alphanumeric, `-`, `.`,
   * `=`) so the value could be forwarded to a gateway that accepts references.
   */
  static buildReference(
    providerTransactionReference: string,
    amountMinor: number,
  ): string {
    const safe = providerTransactionReference.replace(/[^A-Za-z0-9.-=]/g, "-");
    return `RFR-${safe}-${amountMinor}`;
  }
}