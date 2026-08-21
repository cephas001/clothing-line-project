// apps/api/src/domain/entities/Product.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ProductVariant } from "@api-domain-entities/ProductVariant";
import { ProductMedia } from "@api-domain-entities/ProductMedia";

/**
 * ProductProps
 * - Plain data shape used to construct a Product entity.
 */
export interface ProductProps {
  id: string;
  title: string;
  handle: string;
  description?: string;
  variants?: ProductVariant[];
  categoryIds?: string[];
  salesChannelIds?: string[];
  media?: ProductMedia[];
}

/**
 * Product
 *
 * Domain entity representing a product catalog record.
 * - Validates required fields at construction.
 * - Maintains collections for variants, categories and sales channels using
 *   Map/Set for efficient membership checks and mutation.
 * - All public methods validate inputs and throw DomainError on invalid state.
 */
export class Product {
  // -------------------------
  // Identity / core fields
  // -------------------------
  readonly id: string;
  private _title: string;
  private _handle: string;
  public description: string | null;

  // -------------------------
  // Collections (internal)
  // -------------------------
  // Variants keyed by variant id for quick lookup
  private _variants: Map<string, ProductVariant>;
  // Category and sales channel membership stored as sets to avoid duplicates
  private _categoryIds: Set<string>;
  private _salesChannelIds: Set<string>;
  // Media references in display order (lowest sortOrder first)
  private _media: ProductMedia[];

  // -------------------------
  // Constructor and validation
  // -------------------------
  constructor(props: ProductProps) {
    // Basic validation: title and handle are required and non-empty
    if (!props.title || props.title.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Product title cannot be empty.",
      );
    }
    if (!props.handle || props.handle.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Product handle cannot be empty.",
      );
    }

    // Identity / core
    this.id = props.id;
    this._title = props.title;
    // Normalize handle to lowercase for consistent lookups
    this._handle = props.handle.toLowerCase();
    this.description = props.description || null;

    // Initialize variants map (defensive copy)
    this._variants = new Map();
    if (props.variants) {
      props.variants.forEach((variant) =>
        this._variants.set(variant.id, variant),
      );
    }

    // Initialize category and sales channel sets (defensive copy + trim)
    this._categoryIds = new Set();
    if (props.categoryIds) {
      props.categoryIds.forEach((id) => {
        if (id && id.trim()) this._categoryIds.add(id);
      });
    }

    this._salesChannelIds = new Set();
    if (props.salesChannelIds) {
      props.salesChannelIds.forEach((id) => {
        if (id && id.trim()) this._salesChannelIds.add(id);
      });
    }

    // Initialize media references (defensive copy; constructor trusts the
    // ProductMedia value object's own invariant validation).
    this._media = props.media ? Array.from(props.media) : [];
  }

  // -------------------------
  // Variant management
  // -------------------------

  /**
   * addVariant
   * - Add a new variant to the product.
   * - Throws INVALID_OPERATION if a variant with the same id already exists.
   */
  public addVariant(variant: ProductVariant): void {
    if (this._variants.has(variant.id)) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Variant already exists on this product.",
      );
    }
    this._variants.set(variant.id, variant);
  }

  /**
   * variants (getter)
   * - Returns an array copy of the product's variants.
   */
  get variants(): ProductVariant[] {
    return Array.from(this._variants.values());
  }

  // -------------------------
  // Title / handle accessors
  // -------------------------

  /**
   * title (getter)
   * - Expose product title.
   */
  get title(): string {
    return this._title;
  }

  /**
   * handle (getter)
   * - Expose normalized handle.
   */
  get handle(): string {
    return this._handle;
  }

  // -------------------------
  // Category membership
  // -------------------------

  /**
   * assignCategories
   * - Replace the product's category membership with the provided list.
   * - Filters out invalid/empty ids.
   */
  public assignCategories(categoryIds: string[]): void {
    this._categoryIds = new Set(
      (Array.isArray(categoryIds) ? categoryIds : []).filter(
        (id) => typeof id === "string" && id.trim() !== "",
      ),
    );
  }

  /**
   * addCategory
   * - Add a single category id to the product.
   * - Validates non-empty categoryId.
   */
  public addCategory(categoryId: string): void {
    if (!categoryId || !categoryId.trim()) {
      throw new DomainError("VALIDATION_ERROR", "categoryId is required.");
    }
    this._categoryIds.add(categoryId);
  }

  /**
   * categoryIds (getter)
   * - Returns an array copy of category ids.
   */
  get categoryIds(): string[] {
    return Array.from(this._categoryIds);
  }

  // -------------------------
  // Sales channel membership
  // -------------------------

  /**
   * assignSalesChannels
   * - Replace the product's sales channel membership with the provided list.
   * - Filters out invalid/empty ids.
   */
  public assignSalesChannels(salesChannelIds: string[]): void {
    this._salesChannelIds = new Set(
      (Array.isArray(salesChannelIds) ? salesChannelIds : []).filter(
        (id) => typeof id === "string" && id.trim() !== "",
      ),
    );
  }

  /**
   * addSalesChannel
   * - Add a single sales channel id to the product.
   * - Validates non-empty salesChannelId.
   */
  public addSalesChannel(salesChannelId: string): void {
    if (!salesChannelId || !salesChannelId.trim()) {
      throw new DomainError("VALIDATION_ERROR", "salesChannelId is required.");
    }
    this._salesChannelIds.add(salesChannelId);
  }

  /**
   * salesChannelIds (getter)
   * - Returns an array copy of sales channel ids.
   */
  get salesChannelIds(): string[] {
    return Array.from(this._salesChannelIds);
  }

  // -------------------------
  // Media references
  // -------------------------

  /**
   * assignMedia
   * - Replace the product's media references with the provided list.
   * - Ignores non-array input (defensive, matching the category/sales-channel
   *   assign methods).
   */
  public assignMedia(media: ProductMedia[]): void {
    this._media = (Array.isArray(media) ? media : []).map((entry) => entry);
  }

  /**
   * media (getter)
   * - Returns a defensive copy of media references in deterministic display
   *   order (lowest sortOrder first, then id for stable ties).
   */
  get media(): ProductMedia[] {
    return Array.from(this._media).sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }
      return a.id.localeCompare(b.id);
    });
  }
}
