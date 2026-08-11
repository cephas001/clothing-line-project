// apps/api/src/domain/entities/Product.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ProductVariant } from "@api-domain-entities/ProductVariant";

export interface ProductProps {
  id: string;
  title: string;
  handle: string;
  description?: string;
  variants?: ProductVariant[];
  categoryIds?: string[];
  salesChannelIds?: string[];
}

export class Product {
  readonly id: string;
  private _title: string;
  private _handle: string;
  public description: string | null;
  private _variants: Map<string, ProductVariant>;
  private _categoryIds: Set<string>;
  private _salesChannelIds: Set<string>;

  constructor(props: ProductProps) {
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

    this.id = props.id;
    this._title = props.title;
    this._handle = props.handle.toLowerCase();
    this.description = props.description || null;

    this._variants = new Map();
    if (props.variants) {
      props.variants.forEach((variant) =>
        this._variants.set(variant.id, variant),
      );
    }

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
  }

  public addVariant(variant: ProductVariant): void {
    if (this._variants.has(variant.id)) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Variant already exists on this product.",
      );
    }
    this._variants.set(variant.id, variant);
  }

  get title(): string {
    return this._title;
  }

  get handle(): string {
    return this._handle;
  }

  get variants(): ProductVariant[] {
    return Array.from(this._variants.values());
  }

  // --- Category / sales channel membership (many-to-many)
  public assignCategories(categoryIds: string[]): void {
    this._categoryIds = new Set(
      (Array.isArray(categoryIds) ? categoryIds : []).filter(
        (id) => typeof id === "string" && id.trim() !== "",
      ),
    );
  }

  public addCategory(categoryId: string): void {
    if (!categoryId || !categoryId.trim()) {
      throw new DomainError("VALIDATION_ERROR", "categoryId is required.");
    }
    this._categoryIds.add(categoryId);
  }

  public assignSalesChannels(salesChannelIds: string[]): void {
    this._salesChannelIds = new Set(
      (Array.isArray(salesChannelIds) ? salesChannelIds : []).filter(
        (id) => typeof id === "string" && id.trim() !== "",
      ),
    );
  }

  public addSalesChannel(salesChannelId: string): void {
    if (!salesChannelId || !salesChannelId.trim()) {
      throw new DomainError("VALIDATION_ERROR", "salesChannelId is required.");
    }
    this._salesChannelIds.add(salesChannelId);
  }

  get categoryIds(): string[] {
    return Array.from(this._categoryIds);
  }

  get salesChannelIds(): string[] {
    return Array.from(this._salesChannelIds);
  }
}
