// apps/api/src/domain/entities/ReturnAuthorization.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";

export type ReturnStatus = "pending" | "approved" | "rejected" | "refunded";

export interface ReturnAuthorizationProps {
  id: string;
  orderId: string;
  refundAmountMinor: number;
  status?: ReturnStatus;
}

export class ReturnAuthorization {
  readonly id: string;
  readonly orderId: string;
  readonly refundAmountMinor: number;
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

    this.id = props.id;
    this.orderId = props.orderId;
    this.refundAmountMinor = props.refundAmountMinor;
    this._status = props.status || "pending";
  }

  public approve(): void {
    if (this._status !== "pending") {
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

  get status(): ReturnStatus {
    return this._status;
  }
}
