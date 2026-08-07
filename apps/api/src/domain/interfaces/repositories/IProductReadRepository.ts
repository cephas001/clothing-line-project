import { Product } from "@api/domain/entities/Product";
import { ProductReadQuery } from "@api/domain/shared/contracts";

export interface IProductReadRepository {
  findMany(
    query: ProductReadQuery,
  ): Promise<{ items: Product[]; total: number }>;
  findByIdAndContext(
    productId: string,
    salesChannelId: string,
    regionId: string,
    expand?: string[],
    fields?: string[],
  ): Promise<Product | null>;
}
