// apps/api/src/domain/entities/Promotion.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";

export type PromotionDiscountType = "percentage" | "fixed_amount";

/**
 * PromotionProps
 * - Plain data shape used to construct a Promotion entity.
 */
export interface PromotionProps {
  id: string;
  code: string;
  discountType: PromotionDiscountType;
  discountValueMinor: number;
  minimumSpendMinor?: number;
  isActive?: boolean;
}

/**
 * Promotion
 *
 * Domain entity representing a discount/promotion.
 * - All monetary values are integers in minor units.
 * - Percentage discounts are expressed in basis points (10000 = 100%).
 * - Validation is strict and throws DomainError on invalid input.
 */
export class Promotion {
  // -------------------------
  // Limits and constants
  // -------------------------
  private static readonly MAX_DISCOUNT_VALUE = 1_000_000_000;
  private static readonly MAX_MINIMUM_SPEND = 1_000_000_000_00;

  // -------------------------
  // Readonly identity
  // -------------------------
  readonly id: string;
  readonly code: string;

  // -------------------------
  // Internal state
  // -------------------------
  private _discountType: PromotionDiscountType;
  private _discountValueMinor: number;
  private _minimumSpendMinor: number;
  private _isActive: boolean;

  // -------------------------
  // Constructor and validation
  // -------------------------
  constructor(props: PromotionProps) {
    // Normalize and validate code
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

    // Validate discount type
    if (
      props.discountType !== "percentage" &&
      props.discountType !== "fixed_amount"
    ) {
      throw new DomainError("VALIDATION_ERROR", "Invalid discount type.");
    }

    // Validate discount value
    if (
      !Number.isInteger(props.discountValueMinor) ||
      props.discountValueMinor < 0
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Discount value must be a non-negative integer.",
      );
    }

    // Percentage-specific cap (basis points)
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

    // Validate minimum spend
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

    // Assign fields (preserve original semantics)
    this.id = props.id;
    this.code = code;
    this._discountType = props.discountType;
    this._discountValueMinor = props.discountValueMinor;
    this._minimumSpendMinor = minimumSpend;
    this._isActive = props.isActive ?? true;
  }

  // -------------------------
  // Accessors
  // -------------------------
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

  // -------------------------
  // Business logic
  // -------------------------

  /**
   * computeDiscountAmount
   * - Computes the discount amount (in minor units) for a given subtotal.
   * - This is the SINGLE authoritative promotion application path: it enforces
   *   minimum spend (strictly — a subtotal below `minimumSpendMinor` is NOT
   *   eligible and throws instead of applying a discount) and computes the
   *   discount with DETERMINISTIC floor division toward zero in integer minor
   *   units only (no floats), capped at the subtotal so a discount can never
   *   exceed the payable base.
   * - Percentage discounts use basis points; fixed discounts are capped at the
   *   subtotal (discount <= subtotal).
   * - Fail-closed: a non-integer or negative subtotal throws a DomainError
   *   instead of being silently coerced, so invalid money never reaches the
   *   authoritative checkout breakdown.
   */
  public computeDiscountAmount(subtotalMinor: number): number {
    if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor < 0) {
      throw new DomainError(
        "NEGATIVE_AMOUNT",
        "Subtotal must be a non-negative safe integer in minor units.",
      );
    }
    if (subtotalMinor < this._minimumSpendMinor) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cart subtotal does not meet the promotion's minimum spend.",
      );
    }
    if (this._discountType === "percentage") {
      const product = subtotalMinor * this._discountValueMinor;
      if (!Number.isSafeInteger(product)) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Discount calculation overflow; the subtotal is too large.",
        );
      }
      const discount = Math.floor(product / 10000);
      return Math.min(discount, subtotalMinor);
    }
    return Math.min(this._discountValueMinor, subtotalMinor);
  }

  // -------------------------
  // State mutation helpers
  // -------------------------
  deactivate(): void {
    this._isActive = false;
  }

  activate(): void {
    this._isActive = true;
  }

  /**
   * updateDiscount
   * - Update discount type and value with the same validation rules as construction.
   */
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

  /**
   * updateMinimumSpend
   * - Update the minimum spend threshold with the same validation rules as construction.
   */
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
