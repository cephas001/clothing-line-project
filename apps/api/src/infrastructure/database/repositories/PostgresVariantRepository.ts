// apps/api/src/infrastructure/database/repositories/PostgresVariantRepository.ts

// Postgres-backed implementation of IVariantRepository.
//
// Persists product variants and supports pessimistic inventory locking with
// `SELECT ... FOR UPDATE NOWAIT`. The NOWAIT lock is the only repo-level lock
// primitive; it runs against the connection resolved by TransactionContext, so
// it participates in whatever ITransactionManager unit of work is active.
//
// When a row is locked by another transaction Postgres raises SQLSTATE 55P03,
// which is normalized to RepositoryErrorCode.NOWAIT for the use-case layer.

import { ProductVariant } from "@api-domain-entities/ProductVariant";
import type { IVariantRepository } from "@api-domain-interfaces/repositories/IVariantRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type VariantRow = {
  id: string;
  product_id: string;
  sku: string;
  inventory_quantity: number;
  allow_backorder: boolean;
  version: number;
};

function toDomain(row: VariantRow): ProductVariant {
  return new ProductVariant({
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    inventoryQuantity: row.inventory_quantity,
    allowBackorder: row.allow_backorder,
    version: row.version,
  });
}

export class PostgresVariantRepository implements IVariantRepository {
  constructor(private readonly context: TransactionContext) {}

  async findBySku(sku: string): Promise<ProductVariant | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("product_variant")
        .selectAll()
        .where("sku", "=", sku)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findById(id: string): Promise<ProductVariant | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("product_variant")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(variant: ProductVariant): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("product_variant")
        .values({
          id: variant.id,
          product_id: variant.productId,
          sku: variant.sku,
          inventory_quantity: variant.inventoryQuantity,
          allow_backorder: variant.allowBackorder,
          version: variant.version,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            product_id: variant.productId,
            sku: variant.sku,
            inventory_quantity: variant.inventoryQuantity,
            allow_backorder: variant.allowBackorder,
            version: variant.version,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async lockVariantForUpdateNoWait(
    variantId: string,
  ): Promise<ProductVariant | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("product_variant")
        .selectAll()
        .where("id", "=", variantId)
        .forUpdate()
        .noWait()
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
