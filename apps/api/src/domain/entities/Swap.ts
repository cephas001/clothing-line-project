// apps/api/src/domain/entities/Swap.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";

export type SwapStatus = "pending" | "completed" | "canceled";

export interface SwapProps {
  id: string;
  orderId: string;
  priceVarianceMinor: number;
  status?: SwapStatus;
}

export class Swap {
  readonly id: string;
  readonly orderId: string;
  readonly priceVarianceMinor: number; // Can be negative (refund) or positive (charge)
  private _status: SwapStatus;

  constructor(props: SwapProps) {
    if (!Number.isInteger(props.priceVarianceMinor)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Price variance must be a whole integer.",
      );
    }

    this.id = props.id;
    this.orderId = props.orderId;
    this.priceVarianceMinor = props.priceVarianceMinor;
    this._status = props.status || "pending";
  }

  public complete(): void {
    if (this._status !== "pending") {
      throw new DomainError(
        "INVALID_STATUS_TRANSITION",
        "Only pending swaps can be completed.",
      );
    }
    this._status = "completed";
  }

  get status(): SwapStatus {
    return this._status;
  }
}
