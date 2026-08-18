// apps/api/src/infrastructure/caching/InvalidatingCatalogRepositories.ts

// Write-repository decorators that bump the product read cache generation
// after every MUTATING write (save). Read methods are forwarded untouched and
// never invalidate. Wired ONLY at the API composition root (mirroring
// CachedProductReadRepository), so every catalog/pricing/inventory mutation
// that reaches these repositories cuts the read cache immediately instead of
// waiting for the TTL.
//
// Invalidation is fail-open: the invalidator never throws, so a Redis hiccup
// can never fail (or roll back) a catalog write.
//
// Scope (audited, L9 Part 3): the ONLY product-read-affecting mutation paths
// in the application are CreateProductUseCase, CreateProductVariantUseCase,
// ConfigureRegionalPricingUseCase and AdjustInventoryLevelUseCase — exactly the
// `save()` calls on the three repositories wrapped here. Reservation and
// checkout write inventory/cart/order/payment repositories, NEVER these three,
// so high-frequency inventory movement can never thrash the read cache. The
// category/sales-channel/promotion write paths are deliberately NOT wrapped:
// they create records that do not change any cached product payload.

import type { MoneyAmount } from "@api/domain/entities/MoneyAmount";
import type { Product } from "@api/domain/entities/Product";
import type { ProductVariant } from "@api/domain/entities/ProductVariant";
import type { IMoneyAmountRepository } from "@api/domain/interfaces/repositories/IMoneyAmountRepository";
import type { IProductRepository } from "@api/domain/interfaces/repositories/IProductRepository";
import type { IVariantRepository } from "@api/domain/interfaces/repositories/IVariantRepository";
import type { IProductReadCacheInvalidator } from "./ProductReadCacheInvalidator";

export class InvalidatingProductRepository implements IProductRepository {
  constructor(
    private readonly source: IProductRepository,
    private readonly invalidator: IProductReadCacheInvalidator,
  ) {}

  findByHandle(handle: string): Promise<Product | null> {
    return this.source.findByHandle(handle);
  }

  findById(id: string): Promise<Product | null> {
    return this.source.findById(id);
  }

  async save(product: Product): Promise<void> {
    await this.source.save(product);
    await this.invalidator.invalidate();
  }
}

export class InvalidatingVariantRepository implements IVariantRepository {
  constructor(
    private readonly source: IVariantRepository,
    private readonly invalidator: IProductReadCacheInvalidator,
  ) {}

  findBySku(sku: string): Promise<ProductVariant | null> {
    return this.source.findBySku(sku);
  }

  findById(id: string): Promise<ProductVariant | null> {
    return this.source.findById(id);
  }

  lockVariantForUpdateNoWait(variantId: string): Promise<ProductVariant | null> {
    return this.source.lockVariantForUpdateNoWait(variantId);
  }

  async save(variant: ProductVariant): Promise<void> {
    await this.source.save(variant);
    await this.invalidator.invalidate();
  }
}

export class InvalidatingMoneyAmountRepository
  implements IMoneyAmountRepository
{
  constructor(
    private readonly source: IMoneyAmountRepository,
    private readonly invalidator: IProductReadCacheInvalidator,
  ) {}

  findById(id: string): Promise<MoneyAmount | null> {
    return this.source.findById(id);
  }

  findRegionalPrice(
    variantId: string,
    regionId: string,
  ): Promise<MoneyAmount | null> {
    return this.source.findRegionalPrice(variantId, regionId);
  }

  async save(moneyAmount: MoneyAmount): Promise<void> {
    await this.source.save(moneyAmount);
    await this.invalidator.invalidate();
  }
}