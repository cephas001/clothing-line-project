// apps/api/src/domain/entities/ReturnAuthorization.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { JsonObject } from "@api/domain/shared/json";

/**
 * ReturnStatus
 * - Finite set of statuses representing the lifecycle of a return authorization.
 */
export type ReturnStatus =
  | "pending_receipt"
  | "pending"
  | "approved"
  | "rejected"
  | "refunded";

/**
 * ReturnAuthorizationItem
 * - Represents a single line item being returned.
 */
export interface ReturnAuthorizationItem {
  lineItemId: string;
  quantity: number;
  reasonCode: string;
}

/**
 * ReturnAuthorizationProps
 * - Plain data shape used to construct a ReturnAuthorization entity.
 */
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

/**
 * ReturnAuthorization
 *
 * Domain entity representing an RMA (return authorization).
 * - Validates items and refund amount at construction.
 * - Encapsulates status transitions with domain guards.
 */
export class ReturnAuthorization {
  // -------------------------
  // Readonly identity / audit
  // -------------------------
  readonly id: string;
  readonly orderId: string;
  readonly createdBy: string;
  readonly createdAt: string;

  // -------------------------
  // Core payload
  // -------------------------
  readonly items: ReturnAuthorizationItem[];
  readonly refundAmountMinor: number;
  readonly shippingLabelUrl: string | null;
  readonly requestedByCustomerId: string | null;
  readonly metadata: JsonObject;

  // -------------------------
  // Mutable status
  // -------------------------
  private _status: ReturnStatus;

  // -------------------------
  // Constructor and validation
  // -------------------------
  constructor(props: ReturnAuthorizationProps) {
    // Validate refund amount (non-negative integer)
    if (
      !Number.isInteger(props.refundAmountMinor) ||
      props.refundAmountMinor < 0
    ) {
      throw new DomainError(
        "NEGATIVE_AMOUNT",
        "Refund amount must be a non-negative integer.",
      );
    }

    // Validate items array shape and each item
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
        if (!Number.isInteger(item.quantity) || item.quantity < 1) {
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

    // Assign properties (defensive copies where appropriate)
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

  // -------------------------
  // Status transitions
  // -------------------------

  /**
   * approve
   * - Approve a pending return.
   * - Guard: only pending or pending_receipt returns can be approved.
   */
  public approve(): void {
    if (this._status !== "pending" && this._status !== "pending_receipt") {
      throw new DomainError(
        "INVALID_STATUS_TRANSITION",
        "Only pending returns can be approved.",
      );
    }
    this._status = "approved";
  }

  /**
   * executeRefund
   * - Mark the return as refunded.
   * - Guard: only approved returns may be refunded.
   */
  public executeRefund(): void {
    if (this._status !== "approved") {
      throw new DomainError(
        "INVALID_STATUS_TRANSITION",
        "Return must be approved before executing a refund.",
      );
    }
    this._status = "refunded";
  }

  /**
   * reject
   * - Reject a return request.
   * - Guard: cannot reject an already approved or refunded return.
   */
  public reject(): void {
    if (this._status === "approved" || this._status === "refunded") {
      throw new DomainError(
        "INVALID_STATUS_TRANSITION",
        "An approved or refunded return cannot be rejected.",
      );
    }
    this._status = "rejected";
  }

  // -------------------------
  // Read-only accessor
  // -------------------------
  get status(): ReturnStatus {
    return this._status;
  }
}
