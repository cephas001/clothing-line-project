// apps/api/src/use-cases/catalog/ProductWithPricing.ts

// Application-layer read model + resolver for the authoritative regional price
// projection.
//
// The storefront must never derive, substitute, or invent a price: the only
// price authority is the pricing service (RegionalPricingService -> money_amount
// rows for the requesting region). GET /products and GET /products/:id resolve
// each variant's regional price HERE, in the application layer, after the
// product read. The price is resolved fresh from Postgres — it is never read
// from, or invalidated through, the product read cache. The HTTP boundary then
// projects priceMinor onto the ProductVariant response.

import { Product } from "@api/domain/entities/Product";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { IPricingService } from "@api/domain/interfaces/services/IPricingService";

/** A product paired with its resolved regional prices, keyed by variant id. */
export interface ProductWithRegionalPricing {
  product: Product;
  priceByVariant: ReadonlyMap<string, number | null>;
}

/**
 * Resolve the authoritative regional price for every variant of a product.
 * Prices are integers in minor units (region currency); null when the variant
 * has no regional price for the region. A pricing failure fails the whole read
 * (fail-closed: financial data is never served partially or guessed).
 */
export async function resolveProductRegionalPricing(
  product: Product,
  regionId: string,
  pricingService: IPricingService,
  logger: ILogger,
): Promise<ProductWithRegionalPricing> {
  const entries = await Promise.all(
    product.variants.map(async (variant) => {
      let priceMinor: number | null = null;
      try {
        priceMinor = await pricingService.getPriceForRegion(
          variant.id,
          regionId,
        );
      } catch (err: unknown) {
        logger.error("Pricing service error while fetching regional price", {
          err,
          variantId: variant.id,
          regionId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to fetch regional price.",
        );
      }
      return [variant.id, priceMinor] as const;
    }),
  );
  return { product, priceByVariant: new Map(entries) };
}