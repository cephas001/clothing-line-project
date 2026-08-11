// apps/api/src/infrastructure/database/repositories/PostgresPromotionRepository.ts

// Postgres-backed implementation of IPromotionRepository.
//
// Manages promotions with an uppercase-normalized unique code. Upserts key on
// the id; the schema's unique code constraint surfaces as DUPLICATE via the
// shared error mapping.

import { Promotion } from "@api/domain/entities/Promotion";
import type { IPromotionRepository } from "@api-domain-interfaces/repositories/IPromotionRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type PromotionRow = {
  id: string;
  code: string;
  discount_type: Promotion["discountType"];
  discount_value_minor: number;
  minimum_spend_minor: number;
  is_active: boolean;
};

function toDomain(row: PromotionRow): Promotion {
  return new Promotion({
    id: row.id,
    code: row.code,
    discountType: row.discount_type,
    discountValueMinor: row.discount_value_minor,
    minimumSpendMinor: row.minimum_spend_minor,
    isActive: row.is_active,
  });
}

export class PostgresPromotionRepository implements IPromotionRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(id: string): Promise<Promotion | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("promotion")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByCode(code: string): Promise<Promotion | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("promotion")
        .selectAll()
        .where("code", "=", code)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(promotion: Promotion): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("promotion")
        .values({
          id: promotion.id,
          code: promotion.code,
          discount_type: promotion.discountType,
          discount_value_minor: promotion.discountValueMinor,
          minimum_spend_minor: promotion.minimumSpendMinor,
          is_active: promotion.isActive,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            code: promotion.code,
            discount_type: promotion.discountType,
            discount_value_minor: promotion.discountValueMinor,
            minimum_spend_minor: promotion.minimumSpendMinor,
            is_active: promotion.isActive,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
