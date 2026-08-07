// apps/api/src/domain/entities/Product.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ProductVariant } from "@api-domain-entities/ProductVariant";

export interface ProductProps {
  id: string;
  title: string;
  handle: string;
  description?: string;
  variants?: ProductVariant[];
}

export class Product {
  readonly id: string;
  private _title: string;
  private _handle: string;
  public description: string | null;
  private _variants: Map<string, ProductVariant>;

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
}
