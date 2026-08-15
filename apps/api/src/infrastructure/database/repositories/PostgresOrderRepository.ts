// apps/api/src/infrastructure/database/repositories/PostgresOrderRepository.ts

// Postgres-backed implementation of IOrderRepository.
//
// The order aggregate spans `order`, its `order_line_item` children and the
// `fulfillment` records referencing it. findById/findByTransactionReference
// hydrate line items and fulfillments so downstream use cases (e.g. fraud
// alert handling reading tracking numbers) work against a fully populated
// entity. save() upserts the order row (including the frozen promotion_snapshot
// recorded at checkout) and replaces the line-item set; the Order entity's
// fulfillments/pendingReturns/availableVariants collections have no direct
// columns and are not persisted here (fulfillments are owned by
// IFulfillmentRepository).

import { Order } from "@api/domain/entities/Order";
import type {
  OrderShippingSnapshot,
  PromotionSnapshot,
} from "@api/domain/shared/contracts";
import type { IOrderRepository } from "@api-domain-interfaces/repositories/IOrderRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type OrderRow = {
  id: string;
  cart_id: string;
  customer_id: string;
  total_minor: number;
  currency: string | null;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  shipping_minor: number;
  insurance_minor: number;
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
  shipping_snapshot: unknown;
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

type FulfillmentRow = {
  id: string;
  order_id: string;
  tracking_number: string;
  courier: string | null;
  label_url: string | null;
  service_level: string | null;
  status: string;
  metadata: unknown;
  provider_shipment_id: string | null;
  created_at: string;
  updated_at: string;
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

function toShippingSnapshot(value: unknown): OrderShippingSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const snapshot = value as Partial<OrderShippingSnapshot>;
  if (
    typeof snapshot.requestToken !== "string" ||
    !snapshot.requestToken ||
    !snapshot.selection ||
    typeof snapshot.selection !== "object" ||
    !snapshot.selection.courierId ||
    !snapshot.selection.serviceCode ||
    !snapshot.selection.quoteId ||
    typeof snapshot.selection.amountMinor !== "number"
  ) {
    return null;
  }
  if (
    !snapshot.destination ||
    typeof snapshot.destination !== "object" ||
    !snapshot.destination.name ||
    !snapshot.destination.email ||
    !snapshot.destination.phone ||
    !Array.isArray(snapshot.parcelItems)
  ) {
    return null;
  }
  return {
    requestToken: snapshot.requestToken,
    selection: snapshot.selection,
    destination: snapshot.destination,
    parcelItems: snapshot.parcelItems,
    dimensions:
      snapshot.dimensions && typeof snapshot.dimensions === "object"
        ? snapshot.dimensions
        : null,
  };
}

function toDomain(
  row: OrderRow,
  lineItemRows: OrderLineItemRow[],
  fulfillmentRows: FulfillmentRow[],
): Order {
  return new Order({
    id: row.id,
    cartId: row.cart_id,
    customerId: row.customer_id,
    totalAmountMinor: row.total_minor,
    currency: row.currency,
    subtotalMinor: row.subtotal_minor,
    discountMinor: row.discount_minor,
    taxMinor: row.tax_minor,
    shippingMinor: row.shipping_minor,
    insuranceMinor: row.insurance_minor,
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
    shippingSnapshot: toShippingSnapshot(row.shipping_snapshot),
    lineItems: lineItemRows.map((li) => ({
      id: li.id,
      variantId: li.variant_id,
      quantity: li.quantity,
      unitPriceMinor: li.unit_price_minor,
      fulfilledQuantity: li.fulfilled_quantity,
    })),
    fulfillments: fulfillmentRows.map((f) => ({
      id: f.id,
      orderId: f.order_id,
      trackingNumber: f.tracking_number,
      courier: f.courier,
      labelUrl: f.label_url,
      serviceLevel: f.service_level,
      status: f.status,
      providerShipmentId: f.provider_shipment_id ?? undefined,
      createdAt: f.created_at,
      metadata:
        f.metadata && typeof f.metadata === "object"
          ? f.metadata
          : undefined,
    })),
    createdAt: row.created_at,
  });
}

export class PostgresOrderRepository implements IOrderRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(orderId: string): Promise<Order | null> {
    try {
      const db = this.context.getDb();

      const orderRow = await db
        .selectFrom("order")
        .selectAll()
        .where("id", "=", orderId)
        .executeTakeFirst();

      if (!orderRow) {
        return null;
      }

      const [lineItemRows, fulfillmentRows] = await Promise.all([
        db
          .selectFrom("order_line_item")
          .selectAll()
          .where("order_id", "=", orderId)
          .execute(),
        db
          .selectFrom("fulfillment")
          .selectAll()
          .where("order_id", "=", orderId)
          .execute(),
      ]);

      return toDomain(orderRow, lineItemRows, fulfillmentRows);
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByTransactionReference(reference: string): Promise<Order | null> {
    try {
      const db = this.context.getDb();

      const orderRow = await db
        .selectFrom("order")
        .selectAll()
        .where("transaction_reference", "=", reference)
        .executeTakeFirst();

      if (!orderRow) {
        return null;
      }

      const [lineItemRows, fulfillmentRows] = await Promise.all([
        db
          .selectFrom("order_line_item")
          .selectAll()
          .where("order_id", "=", orderRow.id)
          .execute(),
        db
          .selectFrom("fulfillment")
          .selectAll()
          .where("order_id", "=", orderRow.id)
          .execute(),
      ]);

      return toDomain(orderRow, lineItemRows, fulfillmentRows);
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(order: Order): Promise<void> {
    try {
      const db = this.context.getDb();

      await db
        .insertInto("order")
        .values({
          id: order.id,
          cart_id: order.cartId,
          customer_id: order.customerId,
          total_minor: order.totalAmountMinor,
          currency: order.currency,
          subtotal_minor: order.subtotalMinor,
          discount_minor: order.discountMinor,
          tax_minor: order.taxMinor,
          shipping_minor: order.shippingMinor,
          insurance_minor: order.insuranceMinor,
          fulfillment_status: order.fulfillmentStatus,
          payment_status: order.paymentStatus,
          transaction_reference: order.transactionReference,
          payment_status_reason: order.paymentStatusReason,
          payment_status_updated_at: order.paymentStatusUpdatedAt,
          flagged_for_review: order.flaggedForReview,
          flag_reason: order.flagReason,
          risk_score: order.riskScore,
          flagged_at: order.flaggedAt,
          fulfillment_halted_at: order.fulfillmentHaltedAt,
          promotion_snapshot: order.promotionSnapshot
            ? JSON.stringify(order.promotionSnapshot)
            : null,
          shipping_snapshot: order.shippingSnapshot
            ? JSON.stringify(order.shippingSnapshot)
            : null,
          created_at: order.createdAt,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            cart_id: order.cartId,
            customer_id: order.customerId,
            total_minor: order.totalAmountMinor,
            currency: order.currency,
            subtotal_minor: order.subtotalMinor,
            discount_minor: order.discountMinor,
            tax_minor: order.taxMinor,
            shipping_minor: order.shippingMinor,
            insurance_minor: order.insuranceMinor,
            fulfillment_status: order.fulfillmentStatus,
            payment_status: order.paymentStatus,
            transaction_reference: order.transactionReference,
            payment_status_reason: order.paymentStatusReason,
            payment_status_updated_at: order.paymentStatusUpdatedAt,
            flagged_for_review: order.flaggedForReview,
            flag_reason: order.flagReason,
            risk_score: order.riskScore,
            flagged_at: order.flaggedAt,
            fulfillment_halted_at: order.fulfillmentHaltedAt,
            promotion_snapshot: order.promotionSnapshot
              ? JSON.stringify(order.promotionSnapshot)
              : null,
            shipping_snapshot: order.shippingSnapshot
              ? JSON.stringify(order.shippingSnapshot)
              : null,
          }),
        )
        .execute();

      // Replace the line-item set so children mirror the aggregate's line items.
      await db
        .deleteFrom("order_line_item")
        .where("order_id", "=", order.id)
        .execute();

      if (order.lineItems.length > 0) {
        await db
          .insertInto("order_line_item")
          .values(
            order.lineItems.map((li) => ({
              id: li.id,
              order_id: order.id,
              variant_id: li.variantId ?? null,
              quantity: li.quantity,
              unit_price_minor: li.unitPriceMinor,
              fulfilled_quantity: li.fulfilledQuantity ?? null,
            })),
          )
          .execute();
      }
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async hasCustomerPurchasedProduct(
    customerId: string,
    productId: string,
  ): Promise<boolean> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("order")
        .innerJoin("order_line_item", "order_line_item.order_id", "order.id")
        .innerJoin(
          "product_variant",
          "product_variant.id",
          "order_line_item.variant_id",
        )
        .select("order.id")
        .where("order.customer_id", "=", customerId)
        .where("product_variant.product_id", "=", productId)
        .where("order.payment_status", "=", "captured")
        .limit(1)
        .executeTakeFirst();

      return Boolean(row);
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
