// apps/api/src/infrastructure/database/repositories/PostgresVariantReadRepository.ts

// Postgres-backed implementation of IVariantReadRepository.
//
// Read-only projection of a product variant, used by catalog browsing use
// cases that must not mutate inventory. Shares the VariantRow mapping with the
// write-side IVariantRepository.

import { ProductVariant } from "@api/domain/entities/ProductVariant";
import type { IVariantReadRepository } from "@api-domain-interfaces/repositories/IVariantReadRepository";
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

export class PostgresVariantReadRepository implements IVariantReadRepository {
  constructor(private readonly context: TransactionContext) {}

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
}
