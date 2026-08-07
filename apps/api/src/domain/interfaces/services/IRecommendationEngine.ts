import { Product } from "@api/domain/entities/Product";

export interface IRecommendationEngine {
  getRelatedProducts(
    productId: string,
    salesChannelId: string,
    regionId: string,
    limit: number,
  ): Promise<Product[]>;
}
