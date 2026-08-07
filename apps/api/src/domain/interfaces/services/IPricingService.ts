export interface IPricingService {
  getPriceForRegion(
    variantId: string,
    regionId: string,
  ): Promise<number | null>;
}
