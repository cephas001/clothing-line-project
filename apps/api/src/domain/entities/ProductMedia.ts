// apps/api/src/domain/entities/ProductMedia.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";

export interface ProductMediaProps {
  id: string;
  url: string;
  kind?: string;
  altText?: string | null;
  sortOrder?: number;
}

/**
 * ProductMedia
 *
 * Immutable value object describing a product MEDIA REFERENCE (never the
 * binary itself). `url` is a location the client can fetch (the dev seed uses
 * relative asset paths; production may use a CDN). `kind` classifies the
 * media (defaults to "image"); `sortOrder` is the deterministic display order
 * (lower first). Pure domain model: validates invariants, touches no
 * repositories, loggers, or databases.
 */
export class ProductMedia {
  readonly id: string;
  readonly url: string;
  readonly kind: string;
  readonly altText: string | null;
  readonly sortOrder: number;

  constructor(props: ProductMediaProps) {
    if (!props.id || props.id.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Product media id cannot be empty.",
      );
    }
    if (!props.url || props.url.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Product media url cannot be empty.",
      );
    }
    if (props.sortOrder !== undefined && !Number.isInteger(props.sortOrder)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Product media sortOrder must be an integer.",
      );
    }
    if ((props.sortOrder ?? 0) < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Product media sortOrder cannot be negative.",
      );
    }

    this.id = props.id;
    this.url = props.url;
    this.kind = (props.kind ?? "image").trim() || "image";
    this.altText = props.altText ?? null;
    this.sortOrder = props.sortOrder ?? 0;
  }
}