// apps/api/src/infrastructure/services/RegionalPricingService.ts

import { IMoneyAmountRepository } from "@api/domain/interfaces/repositories/IMoneyAmountRepository";
import { IPricingService } from "@api/domain/interfaces/services/IPricingService";

/**
 * RegionalPricingService
 *
 * Concrete IPricingService backed by the MoneyAmount repository.
 * - Resolves the AUTHORITATIVE price for a (variant, region) pair.
 * - Returns the price in integer minor units, denominated in the region's
 *   currency (currency is a property of the region, never of the price row).
 * - Returns null when no regional price exists; consumers map null to
 *   REGIONAL_PRICE_MISSING. There is NO fallback to a base price or to
 *   another region's price — the regional price IS the price.
 * - Never owns transactions and never mutates state; it is a read-only
 *   domain service and never contacts external providers.
 */
export class RegionalPricingService implements IPricingService {
  constructor(private readonly moneyAmountRepository: IMoneyAmountRepository) {}

  async getPriceForRegion(
    variantId: string,
    regionId: string,
  ): Promise<number | null> {
    const moneyAmount = await this.moneyAmountRepository.findRegionalPrice(
      variantId,
      regionId,
    );
    if (!moneyAmount) {
      return null;
    }
    return moneyAmount.amountMinor;
  }
}