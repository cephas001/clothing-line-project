// apps/api/src/domain/entities/ReturnAuthorization.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { JsonObject } from "@api/domain/shared/json";

export type ReturnStatus =
  | "pending_receipt"
  | "pending"
  | "approved"
  | "rejected"
  | "refunded";

export interface ReturnAuthorizationItem {
  lineItemId: string;
  quantity: number;
  reasonCode: string;
}

export interface ReturnAuthorizationProps {
  id: string;
  orderId: string;
  items?: ReturnAuthorizationItem[];
  refundAmountMinor: number;
  status?: ReturnStatus;
  shippingLabelUrl?: string | null;
  requestedByCustomerId?: string | null;
  createdBy?: string;
  createdAt?: string;
  metadata?: JsonObject;
}

export class ReturnAuthorization {
  readonly id: string;
  readonly orderId: string;
  readonly items: ReturnAuthorizationItem[];
  readonly refundAmountMinor: number;
  readonly shippingLabelUrl: string | null;
  readonly requestedByCustomerId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly metadata: JsonObject;
  private _status: ReturnStatus;

  constructor(props: ReturnAuthorizationProps) {
    if (
      !Number.isInteger(props.refundAmountMinor) ||
      props.refundAmountMinor < 0
    ) {
      throw new DomainError(
        "NEGATIVE_AMOUNT",
        "Refund amount must be a non-negative integer.",
      );
    }

    if (props.items) {
      for (const [idx, item] of props.items.entries()) {
        if (!item || typeof item !== "object") {
          throw new DomainError(
            "VALIDATION_ERROR",
            `Return item at index ${idx} is invalid.`,
          );
        }
        if (!item.lineItemId || typeof item.lineItemId !== "string") {
          throw new DomainError(
            "VALIDATION_ERROR",
            `Return item at index ${idx} must include a lineItemId.`,
          );
        }
        if (
          !Number.isInteger(item.quantity) ||
          item.quantity < 1
        ) {
          throw new DomainError(
            "VALIDATION_ERROR",
            `Return item at index ${idx} must have a positive integer quantity.`,
          );
        }
        if (!item.reasonCode || typeof item.reasonCode !== "string") {
          throw new DomainError(
            "VALIDATION_ERROR",
            `Return item at index ${idx} must include a reasonCode.`,
          );
        }
      }
    }

    this.id = props.id;
    this.orderId = props.orderId;
    this.items = props.items ? [...props.items] : [];
    this.refundAmountMinor = props.refundAmountMinor;
    this.shippingLabelUrl = props.shippingLabelUrl ?? null;
    this.requestedByCustomerId = props.requestedByCustomerId ?? null;
    this.createdBy = props.createdBy ?? "system";
    this.createdAt = props.createdAt ?? new Date().toISOString();
    this.metadata = props.metadata ? { ...props.metadata } : {};
    this._status = props.status || "pending";
  }

  public approve(): void {
    if (this._status !== "pending" && this._status !== "pending_receipt") {
      throw new DomainError(
        "INVALID_STATUS_TRANSITION",
        "Only pending returns can be approved.",
      );
    }
    this._status = "approved";
  }

  public executeRefund(): void {
    if (this._status !== "approved") {
      throw new DomainError(
        "INVALID_STATUS_TRANSITION",
        "Return must be approved before executing a refund.",
      );
    }
    this._status = "refunded";
  }

  public reject(): void {
    if (this._status === "approved" || this._status === "refunded") {
      throw new DomainError(
        "INVALID_STATUS_TRANSITION",
        "An approved or refunded return cannot be rejected.",
      );
    }
    this._status = "rejected";
  }

  get status(): ReturnStatus {
    return this._status;
  }
}