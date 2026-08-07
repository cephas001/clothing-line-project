// apps/api/src/domain/entities/Region.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";

export interface RegionProps {
  id: string;
  name: string;
  currencyCode: string;
  taxRate: number; // Stored as basis points (e.g., 1250 = 12.5%) for precision
  paymentProviders: string[];
  fulfillmentProviders: string[];
}

export class Region {
  readonly id: string;
  public name: string;
  readonly currencyCode: string;
  private _taxRate: number;
  public paymentProviders: string[];
  public fulfillmentProviders: string[];

  constructor(props: RegionProps) {
    if (!props.currencyCode || props.currencyCode.length !== 3) {
      throw new DomainError(
        "INVALID_CURRENCY",
        "Currency code must be a standard 3-letter ISO string.",
      );
    }
    if (!Number.isInteger(props.taxRate) || props.taxRate < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Tax rate must be a non-negative integer representing basis points.",
      );
    }

    this.id = props.id;
    this.name = props.name;
    this.currencyCode = props.currencyCode.toLowerCase();
    this._taxRate = props.taxRate;
    this.paymentProviders = props.paymentProviders;
    this.fulfillmentProviders = props.fulfillmentProviders;
  }

  public updateTaxRate(newRate: number): void {
    if (!Number.isInteger(newRate) || newRate < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Tax rate must be a non-negative integer.",
      );
    }
    this._taxRate = newRate;
  }

  get taxRate(): number {
    return this._taxRate;
  }
}
