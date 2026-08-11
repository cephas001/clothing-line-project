// apps/api/src/infrastructure/database/repositories/PostgresSwapRepository.ts

// Postgres-backed implementation of ISwapRepository.
//
// Persists Swap aggregate values. The row is upserted on id; repeated saves
// (e.g. status transitions after payment/refund side effects in
// ProcessOrderSwapVarianceUseCase) update the row in place. created_at is
// written explicitly because the aggregate carries it.

import type { Swap } from "@api-domain-entities/Swap";
import type { ISwapRepository } from "@api-domain-interfaces/repositories/ISwapRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";



export class PostgresSwapRepository implements ISwapRepository {
  constructor(private readonly context: TransactionContext) {}

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
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
