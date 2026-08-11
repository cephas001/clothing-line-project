// apps/api/src/domain/entities/CartLineItem.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";

/**
 * Plain props used to construct a CartLineItem.
 */
export interface CartLineItemProps {
  id: string;
  cartId: string;
  variantId?: string | null;
  quantity: number;
  unitPriceMinor: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  title?: string;
}

/**
 * CartLineItem
 *
 * Domain entity representing a single line item inside a Cart.
 * - All monetary values are expressed in minor units (e.g., Kobo).
 * - Quantity is an integer and strictly validated.
 * - Custom items (no variantId) must include a title.
 */
export class CartLineItem {
  // -------------------------
  // Constants
  // -------------------------
  private static readonly MAX_QUANTITY = 1_000_000;

  // -------------------------
  // Readonly identity / pricing
  // -------------------------
  readonly id: string;
  readonly cartId: string;
  readonly variantId: string | null;
  readonly unitPriceMinor: number;

  // -------------------------
  // Mutable state
  // -------------------------
  private _quantity: number;
  readonly metadata: Record<string, unknown>;
  public createdAt: string;
  public title?: string;

  // -------------------------
  // Constructor and validation
  // -------------------------
  constructor(props: CartLineItemProps) {
    // Custom line items (no variant) must have a title for identification.
    if (!props.variantId && !props.title?.trim()) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Custom line items must include a title.",
      );
    }

    // Quantity must be a positive integer within allowed bounds.
    if (!Number.isInteger(props.quantity) || props.quantity < 1) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Purchase quantity must always be an integer greater than zero.",
      );
    }
    if (props.quantity > CartLineItem.MAX_QUANTITY) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Purchase quantity exceeds the allowed maximum.",
      );
    }

    // Unit price must be a non-negative integer (minor units).
    if (!Number.isInteger(props.unitPriceMinor) || props.unitPriceMinor < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Financial values must be non-negative integers representing Kobo.",
      );
    }

    // Assign properties (preserve original semantics).
    this.id = props.id;
    this.cartId = props.cartId;
    this.variantId = props.variantId ?? null;
    this._quantity = props.quantity;
    this.unitPriceMinor = props.unitPriceMinor;
    this.metadata = props.metadata || {};
    this.createdAt = props.createdAt;
    this.title = props.title;
  }

  // -------------------------
  // Domain behavior: quantity mutation
  // -------------------------

  /**
   * updateQuantity
   * - Validate and set a new quantity for the line item.
   * - Enforces integer, positive, and maximum constraints.
   */
  public updateQuantity(newQuantity: number): void {
    if (!Number.isInteger(newQuantity) || newQuantity < 1) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Purchase quantity must always be an integer greater than zero.",
      );
    }
    if (newQuantity > CartLineItem.MAX_QUANTITY) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Purchase quantity exceeds the allowed maximum.",
      );
    }
    this._quantity = newQuantity;
  }

  /**
   * quantity (getter)
   * - Expose the current quantity as a read-only value.
   */
  get quantity(): number {
    return this._quantity;
  }

  /**
   * lineTotalMinor (getter)
   * - Compute the line total in minor currency units.
   */
  get lineTotalMinor(): number {
    return this._quantity * this.unitPriceMinor;
  }

  // -------------------------
  // Utilities
  // -------------------------

  /**
   * copyForCart
   * - Create a copy of this line item for insertion into another cart.
   * - Preserves pricing, metadata and title; allows new id and cartId.
   */
  public copyForCart(id: string, cartId: string): CartLineItem {
    return new CartLineItem({
      id,
      cartId,
      variantId: this.variantId,
      quantity: this.quantity,
      unitPriceMinor: this.unitPriceMinor,
      metadata: this.metadata,
      createdAt: this.createdAt,
      title: this.title,
    });
  }
}
