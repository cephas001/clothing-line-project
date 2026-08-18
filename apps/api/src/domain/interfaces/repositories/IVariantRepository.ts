import { ProductVariant } from "@api-domain-entities/ProductVariant";

export interface IVariantRepository {
  findBySku(sku: string): Promise<ProductVariant | null>;
  save(variant: ProductVariant): Promise<void>;
  findById(id: string): Promise<ProductVariant | null>;
  /**
   * Acquire a row-level lock on the variant within the transaction established
   * by the current ITransactionManager. Runs inside the manager's unit of work;
   * no transaction client is surfaced to callers.
   *
   * ARCHITECTURAL NOTE — retained low-level primitive, NOT the reservation
   * path. L9 inventory reservation relies on ATOMIC CONDITIONAL mutations
   * (`IInventoryLevelRepository.reserveAvailable`/`releaseReserved`/
   * `confirmReserved`, single `UPDATE inventory_level ... WHERE
   * available_quantity >= ?` statements) that never pessimistically lock.
   * Standard checkout therefore never calls this method; it exists only for
   * legitimate future use cases that genuinely require a serialized write lock
   * on a single variant row. Do not wire it into checkout reservation.
   */
  lockVariantForUpdateNoWait(
    variantId: string,
  ): Promise<ProductVariant | null>;
}
