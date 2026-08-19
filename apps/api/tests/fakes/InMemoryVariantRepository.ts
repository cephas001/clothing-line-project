// apps/api/tests/fakes/InMemoryVariantRepository.ts
//
// In-memory IVariantRepository for swap-finalization assertions (restock of
// the returned variant, deduction from the replacement variant). The row lock
// (`lockVariantForUpdateNoWait`) resolves the variant from the current map,
// which simulates the in-transaction lock primitive the swap use case needs.

import { ProductVariant } from "@api/domain/entities/ProductVariant";
import type { IVariantRepository } from "@api/domain/interfaces/repositories/IVariantRepository";
import type { Snapshotable } from "./cloneEntity";
import { cloneValue } from "./cloneEntity";

export class InMemoryVariantRepository
  implements IVariantRepository, Snapshotable
{
  private readonly variants = new Map<string, ProductVariant>();

  seed(variant: ProductVariant): void {
    this.variants.set(variant.id, variant);
  }

  get all(): ProductVariant[] {
    return [...this.variants.values()];
  }

  async findBySku(sku: string): Promise<ProductVariant | null> {
    for (const variant of this.variants.values()) {
      if (variant.sku === sku) {
        return variant;
      }
    }
    return null;
  }

  async findById(id: string): Promise<ProductVariant | null> {
    return this.variants.get(id) ?? null;
  }

  async lockVariantForUpdateNoWait(
    variantId: string,
  ): Promise<ProductVariant | null> {
    return this.variants.get(variantId) ?? null;
  }

  async save(variant: ProductVariant): Promise<void> {
    this.variants.set(variant.id, variant);
  }

  snapshot(): unknown {
    return cloneValue([...this.variants.values()]);
  }

  restore(state: unknown): void {
    this.variants.clear();
    for (const variant of state as ProductVariant[]) {
      this.variants.set(variant.id, variant);
    }
  }
}