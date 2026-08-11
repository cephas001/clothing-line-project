// apps/api/src/infrastructure/database/repositories/PostgresMoneyAmountRepository.ts

// Postgres-backed implementation of IMoneyAmountRepository.
//
// Persists regional prices (money_amount) with an upsert keyed on the natural
// (variant_id, region_id) pair enforced by the unique constraint, so
// ConfigureRegionalPricingUseCase can set/replace a regional price without a
// separate read-then-write round trip. Monetary amounts are BIGINT in the
// schema and arrive as `number` via the INT8 parser configured in
// connection/kysely.ts.

import { MoneyAmount } from "@api/domain/entities/MoneyAmount";
import type { IMoneyAmountRepository } from "@api-domain-interfaces/repositories/IMoneyAmountRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type MoneyAmountRow = {
  id: string;
  variant_id: string;
  region_id: string;
  amount_minor: number;
};

function toDomain(row: MoneyAmountRow): MoneyAmount {
  return new MoneyAmount({
    id: row.id,
    variantId: row.variant_id,
    regionId: row.region_id,
    amountMinor: row.amount_minor,
  });
}

export class PostgresMoneyAmountRepository implements IMoneyAmountRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(id: string): Promise<MoneyAmount | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("money_amount")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findRegionalPrice(
    variantId: string,
    regionId: string,
  ): Promise<MoneyAmount | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("money_amount")
        .selectAll()
        .where("variant_id", "=", variantId)
        .where("region_id", "=", regionId)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(moneyAmount: MoneyAmount): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("money_amount")
        .values({
          id: moneyAmount.id,
          variant_id: moneyAmount.variantId,
          region_id: moneyAmount.regionId,
          amount_minor: moneyAmount.amountMinor,
        })
        .onConflict((oc) =>
          oc.columns(["variant_id", "region_id"]).doUpdateSet({
            id: moneyAmount.id,
            amount_minor: moneyAmount.amountMinor,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
