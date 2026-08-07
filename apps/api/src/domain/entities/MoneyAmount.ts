// apps/api/src/domain/entities/MoneyAmount.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";

export interface MoneyAmountProps {
  id: string;
  variantId: string;
  regionId: string;
  amountMinor: number; // Kobo, Cents, etc.
}

export class MoneyAmount {
  private static readonly MAX_AMOUNT = 1_000_000_000_00;

  readonly id: string;
  readonly variantId: string;
  readonly regionId: string;

  private _amountMinor: number;

  constructor(props: MoneyAmountProps) {
    if (!props.variantId.trim()) {
      throw new DomainError("VALIDATION_ERROR", "Variant ID is required.");
    }

    if (!props.regionId.trim()) {
      throw new DomainError("VALIDATION_ERROR", "Region ID is required.");
    }

    if (!Number.isInteger(props.amountMinor) || props.amountMinor < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Amount must be a non-negative integer in the smallest currency denomination.",
      );
    }
    if (props.amountMinor > MoneyAmount.MAX_AMOUNT) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Amount exceeds the allowed maximum.",
      );
    }

    this.id = props.id;
    this.variantId = props.variantId;
    this.regionId = props.regionId;
    this._amountMinor = props.amountMinor;
  }

  get amountMinor(): number {
    return this._amountMinor;
  }

  updateAmount(amountMinor: number): void {
    if (!Number.isInteger(amountMinor) || amountMinor < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Amount must be a non-negative integer in the smallest currency denomination.",
      );
    }
    if (amountMinor > MoneyAmount.MAX_AMOUNT) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Amount exceeds the allowed maximum.",
      );
    }

    this._amountMinor = amountMinor;
  }
}
