// apps/api/src/domain/entities/Swap.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";

export type SwapStatus =
  | "pending"
  | "awaiting_payment"
  | "refund_pending_manual"
  | "refund_dispatched"
  | "even_exchange"
  | "completed"
  | "canceled";

export interface SwapProps {
  id: string;
  orderId: string;
  returnLineItemId: string;
  returnQuantity: number;
  newVariantId: string;
  newVariantPriceMinor: number;
  originalValueMinor: number;
  differenceMinor: number;
  status?: SwapStatus;
  createdAt?: string;
  createdBy?: string;
  paymentReference?: string | null;
  paymentUrl?: string | null;
}

export class Swap {
  readonly id: string;
  readonly orderId: string;
  readonly returnLineItemId: string;
  readonly returnQuantity: number;
  readonly newVariantId: string;
  readonly newVariantPriceMinor: number;
  readonly originalValueMinor: number;
  readonly differenceMinor: number; // Can be negative (refund) or positive (charge)
  readonly createdAt: string;
  readonly createdBy: string;
  public paymentReference: string | null;
  public paymentUrl: string | null;
  private _status: SwapStatus;

  constructor(props: SwapProps) {
    if (!Number.isInteger(props.differenceMinor)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Price variance must be a whole integer.",
      );
    }
    if (props.returnLineItemId && !props.returnLineItemId.trim()) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "returnLineItemId is required.",
      );
    }
    if (!Number.isInteger(props.returnQuantity) || props.returnQuantity < 1) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "returnQuantity must be a positive integer.",
      );
    }
    if (!props.newVariantId || !props.newVariantId.trim()) {
      throw new DomainError("VALIDATION_ERROR", "newVariantId is required.");
    }
    if (
      !Number.isInteger(props.newVariantPriceMinor) ||
      props.newVariantPriceMinor < 0
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "newVariantPriceMinor must be a non-negative integer.",
      );
    }
    if (
      !Number.isInteger(props.originalValueMinor) ||
      props.originalValueMinor < 0
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "originalValueMinor must be a non-negative integer.",
      );
    }

    this.id = props.id;
    this.orderId = props.orderId;
    this.returnLineItemId = props.returnLineItemId;
    this.returnQuantity = props.returnQuantity;
    this.newVariantId = props.newVariantId;
    this.newVariantPriceMinor = props.newVariantPriceMinor;
    this.originalValueMinor = props.originalValueMinor;
    this.differenceMinor = props.differenceMinor;
    this.createdAt = props.createdAt ?? new Date().toISOString();
    this.createdBy = props.createdBy ?? "system";
    this.paymentReference = props.paymentReference ?? null;
    this.paymentUrl = props.paymentUrl ?? null;
    this._status = props.status || "pending";
  }

  public markAwaitingPayment(props: {
    paymentReference?: string | null;
    paymentUrl?: string | null;
  }): void {
    this._status = "awaiting_payment";
    if (props.paymentReference !== undefined) {
      this.paymentReference = props.paymentReference;
    }
    if (props.paymentUrl !== undefined) {
      this.paymentUrl = props.paymentUrl;
    }
  }

  public markRefundPendingManual(): void {
    this._status = "refund_pending_manual";
  }

  public markRefundDispatched(): void {
    this._status = "refund_dispatched";
  }

  public markEvenExchange(): void {
    this._status = "even_exchange";
  }

  public complete(): void {
    if (this._status === "canceled" || this._status === "completed") {
      throw new DomainError(
        "INVALID_STATUS_TRANSITION",
        "Only active swaps can be completed.",
      );
    }
    this._status = "completed";
  }

  public cancel(): void {
    if (this._status === "completed") {
      throw new DomainError(
        "INVALID_STATUS_TRANSITION",
        "Completed swaps cannot be canceled.",
      );
    }
    this._status = "canceled";
  }

  /**
   * Deterministic business identity of this swap request. Idempotency for swap
   * creation keys on this value (persisted as UNIQUE `swap.natural_key`), NOT
   * on the swap id (which is regenerated per invocation), so re-running the
   * same swap request collides at the database instead of creating a duplicate
   * swap and a second gateway payment/refund.
   */
  get naturalKey(): string {
    return [
      this.orderId,
      this.returnLineItemId,
      this.newVariantId,
      this.returnQuantity,
    ].join("|");
  }

  get status(): SwapStatus {
    return this._status;
  }
}