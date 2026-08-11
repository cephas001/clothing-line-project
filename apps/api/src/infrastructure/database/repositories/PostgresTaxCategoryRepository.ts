// apps/api/src/infrastructure/database/repositories/PostgresTaxCategoryRepository.ts

// Postgres-backed implementation of ITaxCategoryRepository.
//
// Manages tax categories scoped to a region, with a natural unique constraint
// on (name, region_id) used by the upsert in save().

import { TaxCategory } from "@api/domain/entities/TaxCategory";
import type { ITaxCategoryRepository } from "@api-domain-interfaces/repositories/ITaxCategoryRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type TaxCategoryRow = {
  id: string;
  name: string;
  region_id: string;
  rate: number;
};

function toDomain(row: TaxCategoryRow): TaxCategory {
  return new TaxCategory({
    id: row.id,
    name: row.name,
    regionId: row.region_id,
    rate: row.rate,
  });
}

export class PostgresTaxCategoryRepository implements ITaxCategoryRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(id: string): Promise<TaxCategory | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("tax_category")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByNameAndRegion(
    name: string,
    regionId: string,
  ): Promise<TaxCategory | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("tax_category")
        .selectAll()
        .where("name", "=", name)
        .where("region_id", "=", regionId)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(taxCategory: TaxCategory): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("tax_category")
        .values({
          id: taxCategory.id,
          name: taxCategory.name,
          region_id: taxCategory.regionId,
          rate: taxCategory.rate,
        })
        .onConflict((oc) =>
          oc.columns(["name", "region_id"]).doUpdateSet({
            id: taxCategory.id,
            rate: taxCategory.rate,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
