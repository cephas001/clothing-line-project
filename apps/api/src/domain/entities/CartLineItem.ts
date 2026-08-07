// apps/api/src/domain/entities/CartLineItem.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";

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

export class CartLineItem {
  private static readonly MAX_QUANTITY = 1_000_000;

  readonly id: string;
  readonly cartId: string;
  readonly variantId: string | null;
  private _quantity: number;
  readonly unitPriceMinor: number;
  readonly metadata: Record<string, unknown>;
  public createdAt: string;
  public title?: string;

  constructor(props: CartLineItemProps) {
    if (!props.variantId && !props.title?.trim()) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Custom line items must include a title.",
      );
    }
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
    if (!Number.isInteger(props.unitPriceMinor) || props.unitPriceMinor < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Financial values must be non-negative integers representing Kobo.",
      );
    }

    this.id = props.id;
    this.cartId = props.cartId;
    this.variantId = props.variantId ?? null;
    this._quantity = props.quantity;
    this.unitPriceMinor = props.unitPriceMinor;
    this.metadata = props.metadata || {};
    this.createdAt = props.createdAt;
    this.title = props.title;
  }

  // Domain Behavior: Quantity Mutation
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

  get quantity(): number {
    return this._quantity;
  }

  get lineTotalMinor(): number {
    return this._quantity * this.unitPriceMinor;
  }

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
