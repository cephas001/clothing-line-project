import { ProductVariant } from "@api/domain/entities/ProductVariant";

export interface IVariantReadRepository {
  findById(id: string): Promise<ProductVariant | null>;
}
