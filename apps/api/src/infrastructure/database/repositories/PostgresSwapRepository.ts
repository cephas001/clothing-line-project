// apps/api/src/infrastructure/database/repositories/PostgresSwapRepository.ts

// Postgres-backed implementation of ISwapRepository.
//
// Persists Swap aggregate values. The row is upserted on id; repeated saves
// (e.g. status transitions after payment/refund side effects in
// ProcessOrderSwapVarianceUseCase) update the row in place. created_at is
// written explicitly because the aggregate carries it.
//
// Swap idempotency keys on `natural_key` — the deterministic business identity
// of the swap request (order + line item + target variant + quantity). Its
// UNIQUE constraint makes a re-run of the same swap request collide at the
// database (RepositoryErrorCode.DUPLICATE) instead of creating a duplicate swap
// and a second gateway payment/refund; findByNaturalKey resolves the existing
// row for idempotent replay.

import { Swap, SwapStatus } from "@api-domain-entities/Swap";
import type { ISwapRepository } from "@api-domain-interfaces/repositories/ISwapRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type SwapRow = {
  id: string;
  order_id: string;
  return_line_item_id: string;
  return_quantity: number;
  new_variant_id: string;
  new_variant_price_minor: number;
  original_value_minor: number;
  difference_minor: number;
  status: string;
  created_at: string;
  created_by: string;
  payment_reference: string | null;
  payment_url: string | null;
  natural_key: string | null;
};

function toDomain(row: SwapRow): Swap {
  return new Swap({
    id: row.id,
    orderId: row.order_id,
    returnLineItemId: row.return_line_item_id,
    returnQuantity: row.return_quantity,
    newVariantId: row.new_variant_id,
    newVariantPriceMinor: row.new_variant_price_minor,
    originalValueMinor: row.original_value_minor,
    differenceMinor: row.difference_minor,
    status: row.status as SwapStatus,
    createdAt: row.created_at,
    createdBy: row.created_by,
    paymentReference: row.payment_reference,
    paymentUrl: row.payment_url,
  });
}

export class PostgresSwapRepository implements ISwapRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(id: string): Promise<Swap | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("swap")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByNaturalKey(naturalKey: string): Promise<Swap | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("swap")
        .selectAll()
        .where("natural_key", "=", naturalKey)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(swap: Swap): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("swap")
        .values({
          id: swap.id,
          order_id: swap.orderId,
          return_line_item_id: swap.returnLineItemId,
          return_quantity: swap.returnQuantity,
          new_variant_id: swap.newVariantId,
          new_variant_price_minor: swap.newVariantPriceMinor,
          original_value_minor: swap.originalValueMinor,
          difference_minor: swap.differenceMinor,
          status: swap.status,
          created_at: swap.createdAt,
          created_by: swap.createdBy,
          payment_reference: swap.paymentReference ?? null,
          payment_url: swap.paymentUrl ?? null,
          natural_key: swap.naturalKey,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            order_id: swap.orderId,
            return_line_item_id: swap.returnLineItemId,
            return_quantity: swap.returnQuantity,
            new_variant_id: swap.newVariantId,
            new_variant_price_minor: swap.newVariantPriceMinor,
            original_value_minor: swap.originalValueMinor,
            difference_minor: swap.differenceMinor,
            status: swap.status,
            created_by: swap.createdBy,
            payment_reference: swap.paymentReference ?? null,
            payment_url: swap.paymentUrl ?? null,
            natural_key: swap.naturalKey,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}