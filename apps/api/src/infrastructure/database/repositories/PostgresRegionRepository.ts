// apps/api/src/infrastructure/database/repositories/PostgresRegionRepository.ts

// Postgres-backed implementation of IRegionRepository.
//
// Reference implementation for the repository pattern used across
// apps/api/src/infrastructure/database/repositories: row <-> domain entity
// mapping is explicit, monetary/JSONB columns are handled here, and single
// writes go through a single statement (no transaction orchestration — that is
// owned by ITransactionManager at the use-case layer).
//
// All database access resolves through TransactionContext.getDb(), so calls
// made inside `transactionManager.execute(...)` join the active transaction
// while calls outside it use the pooled connection.

import { Region } from "@api-domain-entities/Region";
import type { IRegionRepository } from "@api-domain-interfaces/repositories/IRegionRepository";
import { TransactionContext } from "../transaction/TransactionContext";

type RegionRow = {
  id: string;
  name: string;
  currency_code: string;
  tax_rate: number;
  payment_providers: string[];
  fulfillment_providers: string[];
};

function toDomain(row: RegionRow): Region {
  return new Region({
    id: row.id,
    name: row.name,
    currencyCode: row.currency_code,
    taxRate: row.tax_rate,
    paymentProviders: row.payment_providers,
    fulfillmentProviders: row.fulfillment_providers,
  });
}

export class PostgresRegionRepository implements IRegionRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(id: string): Promise<Region | null> {
    const row = await this.context
      .getDb()
      .selectFrom("region")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? toDomain(row) : null;
  }

  async save(region: Region): Promise<void> {
    await this.context
      .getDb()
      .insertInto("region")
      .values({
        id: region.id,
        name: region.name,
        currency_code: region.currencyCode,
        tax_rate: region.taxRate,
        payment_providers: JSON.stringify(region.paymentProviders),
        fulfillment_providers: JSON.stringify(region.fulfillmentProviders),
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          name: region.name,
          currency_code: region.currencyCode,
          tax_rate: region.taxRate,
          payment_providers: JSON.stringify(region.paymentProviders),
          fulfillment_providers: JSON.stringify(region.fulfillmentProviders),
        }),
      )
      .execute();
  }
}
