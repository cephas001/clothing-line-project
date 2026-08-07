// apps/api/src/domain/entities/ProductVariant.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";

export interface ProductVariantProps {
  id: string;
  productId: string;
  sku: string;
  inventoryQuantity: number;
  allowBackorder: boolean;
  version?: number;
}

export class ProductVariant {
  private static readonly MAX_INVENTORY = 1_000_000_000;

  readonly id: string;
  readonly productId: string;
  readonly sku: string;
  private _inventoryQuantity: number;
  readonly allowBackorder: boolean;
  private _version: number;

  constructor(props: ProductVariantProps) {
    if (!props.sku || props.sku.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Variant must possess a valid SKU barcode identifier.",
      );
    }
    if (!Number.isInteger(props.inventoryQuantity) || props.inventoryQuantity < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Inventory quantity must be a non-negative whole integer.",
      );
    }
    if (props.inventoryQuantity > ProductVariant.MAX_INVENTORY) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Inventory quantity exceeds the allowed maximum.",
      );
    }

    this.id = props.id;
    this.productId = props.productId;
    this.sku = props.sku;
    this._inventoryQuantity = props.inventoryQuantity;
    this.allowBackorder = props.allowBackorder;
    this._version = props.version || 0;
  }

  public canFulfill(quantity: number): boolean {
    return this.allowBackorder || this._inventoryQuantity >= quantity;
  }

  // Domain Behavior: Inventory Deduction
  public deductInventory(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Deduction quantity must be a positive integer.",
      );
    }

    if (!this.canFulfill(quantity)) {
      throw new DomainError(
        "OUT_OF_STOCK",
        "Cannot oversell physical warehouse stock.",
      );
    }

    this._inventoryQuantity -= quantity;
    this.incrementVersion();
  }

  public setAbsoluteInventory(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Inventory quantity must be a non-negative integer.",
      );
    }
    if (quantity > ProductVariant.MAX_INVENTORY) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Inventory quantity exceeds the allowed maximum.",
      );
    }
    this._inventoryQuantity = quantity;
    this.incrementVersion();
  }

  private incrementVersion(): void {
    // Simple optimistic locking/version increment strategy
    this._version = this._version + 1;
  }

  get inventoryQuantity(): number {
    return this._inventoryQuantity;
  }

  get version(): number {
    return this._version;
  }
}
