import { ProductVariant } from "@api-domain-entities/ProductVariant";

export interface IVariantRepository {
  findBySku(sku: string): Promise<ProductVariant | null>;
  save(variant: ProductVariant): Promise<void>;
  findById(id: string): Promise<ProductVariant | null>;
  /**
   * Acquire a row-level lock on the variant within the transaction established
   * by the current ITransactionManager. Runs inside the manager's unit of work;
   * no transaction client is surfaced to callers.
   */
  lockVariantForUpdateNoWait(
    variantId: string,
  ): Promise<ProductVariant | null>;
}
