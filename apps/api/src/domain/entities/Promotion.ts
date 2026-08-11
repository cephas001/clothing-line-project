// apps/api/src/domain/entities/Promotion.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";

export type PromotionDiscountType = "percentage" | "fixed_amount";

export interface PromotionProps {
  id: string;
  code: string;
  discountType: PromotionDiscountType;
  discountValueMinor: number;
  minimumSpendMinor?: number;
  isActive?: boolean;
}

export class Promotion {
  private static readonly MAX_DISCOUNT_VALUE = 1_000_000_000;
  private static readonly MAX_MINIMUM_SPEND = 1_000_000_000_00;

  readonly id: string;
  readonly code: string;

  private _discountType: PromotionDiscountType;
  private _discountValueMinor: number;
  private _minimumSpendMinor: number;
  private _isActive: boolean;

  constructor(props: PromotionProps) {
    const code = props.code.trim().toUpperCase();

    if (!code) {
      throw new DomainError("VALIDATION_ERROR", "Promotion code is required.");
    }

    if (!/^[A-Z0-9-_]+$/.test(code)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Promotion code contains invalid characters.",
      );
    }

    if (
      props.discountType !== "percentage" &&
      props.discountType !== "fixed_amount"
    ) {
      throw new DomainError("VALIDATION_ERROR", "Invalid discount type.");
    }

    if (
      !Number.isInteger(props.discountValueMinor) ||
      props.discountValueMinor < 0
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Discount value must be a non-negative integer.",
      );
    }

    if (
      props.discountType === "percentage" &&
      props.discountValueMinor > 10000
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Percentage discounts cannot exceed 10000 basis points.",
      );
    }

    if (props.discountValueMinor > Promotion.MAX_DISCOUNT_VALUE) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Discount value exceeds the allowed maximum.",
      );
    }

    const minimumSpend = props.minimumSpendMinor ?? 0;

    if (!Number.isInteger(minimumSpend) || minimumSpend < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Minimum spend must be a non-negative integer.",
      );
    }

    if (minimumSpend > Promotion.MAX_MINIMUM_SPEND) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Minimum spend exceeds the allowed maximum.",
      );
    }

    this.id = props.id;
    this.code = code;
    this._discountType = props.discountType;
    this._discountValueMinor = props.discountValueMinor;
    this._minimumSpendMinor = minimumSpend;
    this._isActive = props.isActive ?? true;
  }

  get discountType(): PromotionDiscountType {
    return this._discountType;
  }

  get discountValueMinor(): number {
    return this._discountValueMinor;
  }

  get minimumSpendMinor(): number {
    return this._minimumSpendMinor;
  }

  get isActive(): boolean {
    return this._isActive;
  }

  /**
   * Computes the discount amount (in minor units) this promotion grants for a
   * given pre-discount subtotal. Percentage discounts are applied in basis
   * points; fixed-amount discounts are capped at the subtotal so the result is
   * never negative.
   */
  public computeDiscountAmount(subtotalMinor: number): number {
    const subtotal = Math.max(0, Math.floor(Number(subtotalMinor) || 0));
    if (this._discountType === "percentage") {
      return Math.floor((subtotal * this._discountValueMinor) / 10000);
    }
    return Math.min(this._discountValueMinor, subtotal);
  }

  deactivate(): void {
    this._isActive = false;
  }

  activate(): void {
    this._isActive = true;
  }

  updateDiscount(type: PromotionDiscountType, value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Discount value must be a non-negative integer.",
      );
    }

    if (type === "percentage" && value > 10000) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Percentage discounts cannot exceed 10000 basis points.",
      );
    }

    if (value > Promotion.MAX_DISCOUNT_VALUE) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Discount value exceeds the allowed maximum.",
      );
    }

    this._discountType = type;
    this._discountValueMinor = value;
  }

  updateMinimumSpend(amountMinor: number): void {
    if (!Number.isInteger(amountMinor) || amountMinor < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Minimum spend must be a non-negative integer.",
      );
    }

    if (amountMinor > Promotion.MAX_MINIMUM_SPEND) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Minimum spend exceeds the allowed maximum.",
      );
    }

    this._minimumSpendMinor = amountMinor;
  }
}
