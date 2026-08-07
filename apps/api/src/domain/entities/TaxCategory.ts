// apps/api/src/domain/entities/TaxCategory.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";

export interface TaxCategoryProps {
  id: string;
  name: string;
  regionId: string;
  rate: number; // basis points (750 = 7.5%)
}

export class TaxCategory {
  private static readonly MAX_RATE = 10_000; // 100% in basis points

  readonly id: string;
  readonly regionId: string;

  private _name: string;
  private _rate: number;

  constructor(props: TaxCategoryProps) {
    if (!props.name.trim()) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Tax category name is required.",
      );
    }

    if (!Number.isInteger(props.rate) || props.rate < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Tax rate must be a non-negative integer expressed in basis points.",
      );
    }

    if (props.rate > TaxCategory.MAX_RATE) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Tax rate cannot exceed 10000 basis points (100%).",
      );
    }

    this.id = props.id;
    this.regionId = props.regionId;
    this._name = props.name.trim();
    this._rate = props.rate;
  }

  get name(): string {
    return this._name;
  }

  get rate(): number {
    return this._rate;
  }

  rename(name: string): void {
    if (!name.trim()) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Tax category name is required.",
      );
    }

    this._name = name.trim();
  }

  updateRate(rate: number): void {
    if (!Number.isInteger(rate) || rate < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Tax rate must be a non-negative integer expressed in basis points.",
      );
    }

    if (rate > TaxCategory.MAX_RATE) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Tax rate cannot exceed 10000 basis points (100%).",
      );
    }

    this._rate = rate;
  }
}
