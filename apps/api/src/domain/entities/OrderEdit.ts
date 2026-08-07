// apps/api/src/domain/entities/OrderEdit.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";

export interface OrderEditChange {
  type: "add" | "remove" | "update";
  lineItemId?: string | null;
  newVariantId?: string | null;
  quantity: number;
  unitPriceMinor?: number;
}

export interface OrderEditProps {
  id: string;
  orderId: string;
  actionType: string; // e.g., "update_address", "modify_quantity"
  reason?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
  status?: "draft" | "confirmed" | "applied" | string;
  differenceDueMinor?: number;
  proposedChanges?: OrderEditChange[];
  confirmedAt?: string | null;
  confirmedBy?: string | null;
  paymentReference?: string | null;
}

export class OrderEdit {
  readonly id: string;
  readonly orderId: string;
  readonly actionType: string;
  readonly reason: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string | null;
  status: string;
  differenceDueMinor: number;
  proposedChanges: OrderEditChange[];
  confirmedAt: string | null;
  confirmedBy: string | null;
  paymentReference: string | null;

  constructor(props: OrderEditProps) {
    if (!props.actionType || props.actionType.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Order edit must define an action type.",
      );
    }

    this.id = props.id;
    this.orderId = props.orderId;
    this.actionType = props.actionType;
    this.reason = props.reason ?? null;
    this.createdBy = props.createdBy ?? null;
    this.createdAt = props.createdAt ?? null;
    this.status = props.status ?? "draft";
    this.differenceDueMinor = Number(props.differenceDueMinor ?? 0);
    this.proposedChanges = Array.isArray(props.proposedChanges)
      ? props.proposedChanges
      : [];
    this.confirmedAt = props.confirmedAt ?? null;
    this.confirmedBy = props.confirmedBy ?? null;
    this.paymentReference = props.paymentReference ?? null;
  }

  markAsApplied(props: { appliedAt: string; appliedBy: string }): void {
    if (!props.appliedAt || !props.appliedBy) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Applied metadata is required.",
      );
    }
    this.status = "applied";
  }

  confirm(props: { confirmedAt: string; confirmedBy: string }): void {
    if (!props.confirmedAt || !props.confirmedBy) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Confirmation metadata is required.",
      );
    }
    this.status = "confirmed";
    this.confirmedAt = props.confirmedAt;
    this.confirmedBy = props.confirmedBy;
  }
}
