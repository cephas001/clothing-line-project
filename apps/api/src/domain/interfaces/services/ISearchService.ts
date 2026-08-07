import { Product } from "@api/domain/entities/Product";

export interface ISearchService {
  search(
    query: string,
    salesChannelId: string,
    regionId: string,
    limit: number,
  ): Promise<Product[]>;
}
