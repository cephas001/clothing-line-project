// apps/api/src/infrastructure/database/repositories/PostgresOrderReadRepository.ts

// Postgres-backed implementation of IOrderReadRepository.
//
// Read-only projection for order history. Returns a paginated list of the
// customer's orders with a total count, hydrating line items so the returned
// entities are usable by downstream logic.

import { Order } from "@api/domain/entities/Order";
import type { PromotionSnapshot } from "@api/domain/shared/contracts";
import type { IOrderReadRepository } from "@api-domain-interfaces/repositories/IOrderReadRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type OrderRow = {
  id: string;
  cart_id: string;
  customer_id: string;
  total_minor: number;
  fulfillment_status: Order["fulfillmentStatus"];
  payment_status: Order["paymentStatus"];
  transaction_reference: string | null;
  payment_status_reason: string | null;
  payment_status_updated_at: string | null;
  flagged_for_review: boolean;
  flag_reason: string | null;
  risk_score: number | null;
  flagged_at: string | null;
  fulfillment_halted_at: string | null;
  promotion_snapshot: unknown;
  created_at: string;
};

type OrderLineItemRow = {
  id: string;
  order_id: string;
  variant_id: string | null;
  quantity: number;
  unit_price_minor: number;
  fulfilled_quantity: number | null;
};

function toPromotionSnapshot(value: unknown): PromotionSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const snapshot = value as Partial<PromotionSnapshot>;
  if (!snapshot.promotionId || !snapshot.code || !snapshot.discountType) {
    return null;
  }
  return {
    promotionId: snapshot.promotionId,
    code: snapshot.code,
    discountType: snapshot.discountType,
    discountValueMinor: snapshot.discountValueMinor ?? 0,
    minimumSpendMinor: snapshot.minimumSpendMinor ?? 0,
    appliedDiscountMinor: snapshot.appliedDiscountMinor ?? 0,
  };
}

function toDomain(row: OrderRow, lineItemRows: OrderLineItemRow[]): Order {
  return new Order({
    id: row.id,
    cartId: row.cart_id,
    customerId: row.customer_id,
    totalAmountMinor: row.total_minor,
    fulfillmentStatus: row.fulfillment_status,
    paymentStatus: row.payment_status,
    transactionReference: row.transaction_reference,
    paymentStatusReason: row.payment_status_reason,
    paymentStatusUpdatedAt: row.payment_status_updated_at,
    flaggedForReview: row.flagged_for_review,
    flagReason: row.flag_reason,
    riskScore: row.risk_score,
    flaggedAt: row.flagged_at,
    fulfillmentHaltedAt: row.fulfillment_halted_at,
    promotionSnapshot: toPromotionSnapshot(row.promotion_snapshot),
    lineItems: lineItemRows.map((li) => ({
      id: li.id,
      variantId: li.variant_id,
      quantity: li.quantity,
      unitPriceMinor: li.unit_price_minor,
      fulfilledQuantity: li.fulfilled_quantity,
    })),
    createdAt: row.created_at,
  });
}

export class PostgresOrderReadRepository implements IOrderReadRepository {
  constructor(private readonly context: TransactionContext) {}

  async findHistoryByCustomerId(
    customerId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: Order[]; total: number }> {
    try {
      const db = this.context.getDb();

      const totalResult = await db
        .selectFrom("order")
        .select(db.fn.countAll().as("count"))
        .where("customer_id", "=", customerId)
        .executeTakeFirst();

      const total = Number(totalResult?.count ?? 0);

      const orderRows = await db
        .selectFrom("order")
        .selectAll()
        .where("customer_id", "=", customerId)
        .orderBy("created_at", "desc")
        .limit(limit)
        .offset(offset)
        .execute();

      const items: Order[] = [];
      for (const orderRow of orderRows) {
        const lineItemRows = await db
          .selectFrom("order_line_item")
          .selectAll()
          .where("order_id", "=", orderRow.id)
          .execute();
        items.push(toDomain(orderRow, lineItemRows));
      }

      return { items, total };
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
