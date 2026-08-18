// apps/api/src/infrastructure/services/RegionalTaxCalculationService.ts

import { Cart } from "@api/domain/entities/Cart";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IRegionRepository } from "@api/domain/interfaces/repositories/IRegionRepository";
import { ITaxCalculationService } from "@api/domain/interfaces/services/ITaxCalculationService";
import { calculateTaxAmountMinor } from "@api/utils/taxUtils";

/**
 * RegionalTaxCalculationService
 *
 * Concrete ITaxCalculationService backed by the Region repository.
 * - Resolves the region's tax rate (basis points) from the cart's region.
 * - Tax base = gross subtotal (cart.cartTotalMinor) in integer minor units.
 * - Applies the SINGLE authoritative tax math (calculateTaxAmountMinor):
 *   floor(base * rate / 10000), deterministic, integer minor units.
 * - Fails closed with REGION_NOT_FOUND when the cart's region is missing or
 *   unconfigured; never invents a rate.
 * - Never owns transactions and never mutates the cart; the caller persists
 *   the computed amount via the cart domain (Cart.applyTax).
 */
export class RegionalTaxCalculationService implements ITaxCalculationService {
  constructor(private readonly regionRepository: IRegionRepository) {}

  async calculateTaxForAddress(cart: Cart): Promise<number> {
    const region = await this.regionRepository.findById(cart.regionId);
    if (!region) {
      throw new DomainError(
        "REGION_NOT_FOUND",
        `No region configured for region '${cart.regionId}'; cannot calculate tax.`,
      );
    }
    return calculateTaxAmountMinor(cart.cartTotalMinor, region.taxRate);
  }
}