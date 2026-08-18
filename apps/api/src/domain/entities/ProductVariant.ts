// apps/api/src/domain/entities/ProductVariant.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";

/**
 * ProductVariantProps
 * - Plain data shape used to construct a ProductVariant entity.
 */
export interface ProductVariantProps {
  id: string;
  productId: string;
  sku: string;
  inventoryQuantity: number;
  allowBackorder: boolean;
  version?: number;
}

/**
 * ProductVariant
 *
 * Domain entity representing a single variant of a product.
 * - Validates SKU and inventory at construction.
 * - Encapsulates inventory checks and mutation with optimistic versioning.
 * - All numeric invariants are enforced and throw DomainError on violation.
 */
export class ProductVariant {
  // -------------------------
  // Constants
  // -------------------------
  private static readonly MAX_INVENTORY = 1_000_000_000;

  // -------------------------
  // Readonly identity
  // -------------------------
  readonly id: string;
  readonly productId: string;
  readonly sku: string;

  // -------------------------
  // Mutable state
  // -------------------------
  private _inventoryQuantity: number;
  readonly allowBackorder: boolean;
  private _version: number;

  // -------------------------
  // Constructor and validation
  // -------------------------
  constructor(props: ProductVariantProps) {
    // SKU must be present and non-empty
    if (!props.sku || props.sku.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Variant must possess a valid SKU barcode identifier.",
      );
    }

    // Inventory must be a non-negative integer within allowed bounds
    if (
      !Number.isInteger(props.inventoryQuantity) ||
      props.inventoryQuantity < 0
    ) {
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

    // Assign properties (preserve original semantics)
    this.id = props.id;
    this.productId = props.productId;
    this.sku = props.sku;
    this._inventoryQuantity = props.inventoryQuantity;
    this.allowBackorder = props.allowBackorder;
    this._version = props.version || 0;
  }

  // -------------------------
  // Inventory checks
  // -------------------------

  /**
   * canFulfill
   * - Returns true if the requested quantity can be fulfilled given current inventory
   *   or if backorders are allowed.
   */
  public canFulfill(quantity: number): boolean {
    return this.allowBackorder || this._inventoryQuantity >= quantity;
  }

  // -------------------------
  // Inventory mutation
  // -------------------------

  /**
   * deductInventory
   * - Deducts quantity from inventory after validating the request.
   * - Throws OUT_OF_STOCK if the deduction would oversell and backorders are disallowed.
   * - Increments internal version for optimistic concurrency.
   * - NOT part of the L9 reservation path: checkout reservations use atomic
   *   conditional UPDATEs on `inventory_level` (IInventoryLevelRepository),
   *   never this variant-level counter. Retained as a domain primitive.
   */
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

  /**
   * restockInventory
   * - Adds returned/restocked quantity back to inventory.
   * - Validates the request and enforces the inventory maximum.
   * - Increments internal version for optimistic concurrency.
   */
  public restockInventory(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Restock quantity must be a positive integer.",
      );
    }

    const next = this._inventoryQuantity + quantity;
    if (next > ProductVariant.MAX_INVENTORY) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Restock exceeds the allowed inventory maximum.",
      );
    }

    this._inventoryQuantity = next;
    this.incrementVersion();
  }

  /**
   * setAbsoluteInventory
   * - Set inventory to an absolute value after validation.
   * - Increments internal version for optimistic concurrency.
   */
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

  // -------------------------
  // Versioning
  // -------------------------

  /**
   * incrementVersion
   * - Simple optimistic locking/version increment strategy.
   */
  private incrementVersion(): void {
    this._version = this._version + 1;
  }

  // -------------------------
  // Accessors
  // -------------------------

  get inventoryQuantity(): number {
    return this._inventoryQuantity;
  }

  get version(): number {
    return this._version;
  }
}
