// apps/api/src/infrastructure/database/repositories/PostgresCartRepository.ts

// Postgres-backed implementation of ICartRepository.
//
// The cart aggregate spans two tables: `cart` and its `cart_line_item`
// children. findById hydrates both; save() upserts the cart row and replaces
// the line-item set (delete + reinsert) so the persisted children always mirror
// the aggregate's items. The applied promotion is stored as a full
// CartPromotionSnapshot (id, code, discount config, isActive) written by
// Cart.applyDiscount, which lets reads reconstruct a real Promotion entity.

import { Cart } from "@api/domain/entities/Cart";
import { CartLineItem } from "@api/domain/entities/CartLineItem";
import { Promotion } from "@api/domain/entities/Promotion";
import type {
  CartPromotionSnapshot,
  ShippingQuote,
} from "@api/domain/shared/contracts";
import type { ICartRepository } from "@api-domain-interfaces/repositories/ICartRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import {
  PostgresRepositoryError,
  toRepositoryError,
} from "./errorMapping";
import { RepositoryErrorCode } from "@api/domain/interfaces/shared/errors/RepositoryError";

type CartRow = {
  id: string;
  region_id: string;
  sales_channel_id: string;
  customer_id: string | null;
  email: string | null;
  country_code: string | null;
  shipping_address: unknown;
  discount: unknown;
  tax_amount_minor: number | null;
  shipping_amount_minor: number | null;
  shipping_service_level: string | null;
  shipping_request_token: string | null;
  shipping_courier_id: string | null;
  shipping_service_code: string | null;
  shipping_quote_id: string | null;
  shipping_currency: string | null;
  shipping_quotes: unknown;
  shipping_quote_fingerprint: string | null;
  insurance_amount_minor: number | null;
  version: number;
  metadata: unknown;
  frozen: boolean;
  frozen_reason: string | null;
  frozen_at: string | null;
  order_id: string | null;
  converted_at: string | null;
  status: string;
  payment_status: string;
  payment_initialized: boolean;
  payment_authorization_url: string | null;
  payment_initialized_at: string | null;
  payment_reference: string | null;
  created_at: string;
  updated_at: string;
};

type CartLineItemRow = {
  id: string;
  cart_id: string;
  variant_id: string | null;
  title: string | null;
  quantity: number;
  unit_price_minor: number;
  metadata: unknown;
  created_at: string;
};

function toPromotionReadModel(discount: unknown): Promotion | null {
  if (!discount || typeof discount !== "object") {
    return null;
  }
  // Hydrate the full CartPromotionSnapshot persisted by Cart.applyDiscount so
  // the aggregate is reconstructed with the exact promotion config that was
  // applied, preserving downstream validation and discount computation.
  const snapshot = discount as Partial<CartPromotionSnapshot>;
  if (!snapshot.id || !snapshot.code || !snapshot.discountType) {
    return null;
  }
  return new Promotion({
    id: snapshot.id,
    code: snapshot.code,
    discountType: snapshot.discountType,
    discountValueMinor: snapshot.discountValueMinor ?? 0,
    minimumSpendMinor: snapshot.minimumSpendMinor ?? 0,
    isActive: snapshot.isActive ?? true,
  });
}

function toPromotionSnapshotJson(cart: Cart): string | null {
  const p = cart.appliedPromotion;
  if (!p) {
    return null;
  }
  return JSON.stringify({
    id: p.id,
    code: p.code,
    discountType: p.discountType,
    discountValueMinor: p.discountValueMinor,
    minimumSpendMinor: p.minimumSpendMinor,
    isActive: p.isActive,
  });
}

function toDomain(row: CartRow, lineItemRows: CartLineItemRow[]): Cart {
  const items = lineItemRows.map(
    (item) =>
      new CartLineItem({
        id: item.id,
        cartId: item.cart_id,
        variantId: item.variant_id,
        quantity: item.quantity,
        unitPriceMinor: item.unit_price_minor,
        metadata:
          item.metadata && typeof item.metadata === "object"
            ? (item.metadata as Record<string, unknown>)
            : {},
        createdAt: item.created_at,
        title: item.title ?? undefined,
      }),
  );

  const shippingAddress =
    row.shipping_address && typeof row.shipping_address === "object"
      ? (row.shipping_address as Record<string, unknown>)
      : null;

  return new Cart({
    id: row.id,
    regionId: row.region_id,
    salesChannelId: row.sales_channel_id,
    customerId: row.customer_id,
    email: row.email,
    items,
    appliedPromotion: toPromotionReadModel(row.discount),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    countryCode: row.country_code,
    shippingAddress,
    taxAmountMinor: row.tax_amount_minor,
    shippingAmountMinor: row.shipping_amount_minor,
    shippingServiceLevel: row.shipping_service_level,
    shippingRequestToken: row.shipping_request_token,
    shippingCourierId: row.shipping_courier_id,
    shippingServiceCode: row.shipping_service_code,
    shippingQuoteId: row.shipping_quote_id,
    shippingCurrency: row.shipping_currency,
    shippingQuotes: Array.isArray(row.shipping_quotes)
      ? (row.shipping_quotes as ShippingQuote[])
      : [],
    shippingQuoteFingerprint: row.shipping_quote_fingerprint,
    insuranceAmountMinor: row.insurance_amount_minor,
    version: row.version,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    frozen: row.frozen,
    frozenReason: row.frozen_reason,
    frozenAt: row.frozen_at,
    orderId: row.order_id,
    convertedAt: row.converted_at,
    status: row.status,
    paymentStatus: row.payment_status,
    paymentInitialized: row.payment_initialized,
    paymentAuthorizationUrl: row.payment_authorization_url,
    paymentInitializedAt: row.payment_initialized_at,
    paymentReference: row.payment_reference,
  });
}

export class PostgresCartRepository implements ICartRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(cartId: string): Promise<Cart | null> {
    try {
      const db = this.context.getDb();

      const cartRow = await db
        .selectFrom("cart")
        .selectAll()
        .where("id", "=", cartId)
        .executeTakeFirst();

      if (!cartRow) {
        return null;
      }

      const lineItemRows = await db
        .selectFrom("cart_line_item")
        .selectAll()
        .where("cart_id", "=", cartId)
        .execute();

      return toDomain(cartRow, lineItemRows);
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(cart: Cart): Promise<void> {
    try {
      const db = this.context.getDb();

      // --- Optimistic-lock guarded UPDATE (L4 save/reset race correction) -----
      // The aggregate is only applied when the row still carries the version it
      // was loaded with. A stale concurrent writer updates 0 rows and is
      // rejected below instead of silently overwriting state.
      const updateResult = await db
        .updateTable("cart")
        .set({
          region_id: cart.regionId,
          sales_channel_id: cart.salesChannelId,
          customer_id: cart.customerId,
          email: cart.email,
          country_code: cart.countryCode,
          shipping_address: cart.shippingAddress
            ? JSON.stringify(cart.shippingAddress)
            : null,
          discount: toPromotionSnapshotJson(cart),
          tax_amount_minor: cart.taxAmountMinor,
          shipping_amount_minor: cart.shippingAmountMinor,
          shipping_service_level: cart.shippingServiceLevel,
          shipping_request_token: cart.shippingRequestToken,
          shipping_courier_id: cart.shippingCourierId,
          shipping_service_code: cart.shippingServiceCode,
          shipping_quote_id: cart.shippingQuoteId,
          shipping_currency: cart.shippingCurrency,
          shipping_quotes:
            cart.shippingQuotes.length > 0
              ? JSON.stringify(cart.shippingQuotes)
              : null,
          shipping_quote_fingerprint: cart.shippingQuoteFingerprint,
          insurance_amount_minor: cart.insuranceAmountMinor,
          version: cart.version,
          metadata: JSON.stringify(cart.metadata),
          frozen: cart.frozen,
          frozen_reason: cart.frozenReason,
          frozen_at: cart.frozenAt,
          order_id: cart.orderId,
          converted_at: cart.convertedAt,
          status: cart.status,
          payment_status: cart.paymentStatus,
          payment_initialized: cart.paymentInitialized,
          payment_authorization_url: cart.paymentAuthorizationUrl,
          payment_initialized_at: cart.paymentInitializedAt,
          payment_reference: cart.paymentReference,
          updated_at: cart.updatedAt,
        })
        .where("id", "=", cart.id)
        .where("version", "=", cart.loadedVersion)
        .executeTakeFirst();

      if (updateResult.numUpdatedRows === 0n) {
        // The row either does not exist yet (brand-new cart) or a concurrent
        // writer moved the version. Distinguish the two before deciding.
        const existing = await db
          .selectFrom("cart")
          .select("id")
          .where("id", "=", cart.id)
          .executeTakeFirst();

        if (existing) {
          throw new PostgresRepositoryError(
            RepositoryErrorCode.LOCKED,
            "Cart was concurrently modified; retry the request.",
            { cartId: cart.id },
          );
        }

        await db
          .insertInto("cart")
          .values({
            id: cart.id,
            region_id: cart.regionId,
            sales_channel_id: cart.salesChannelId,
            customer_id: cart.customerId,
            email: cart.email,
            country_code: cart.countryCode,
            shipping_address: cart.shippingAddress
              ? JSON.stringify(cart.shippingAddress)
              : null,
            discount: toPromotionSnapshotJson(cart),
            tax_amount_minor: cart.taxAmountMinor,
            shipping_amount_minor: cart.shippingAmountMinor,
            shipping_service_level: cart.shippingServiceLevel,
            shipping_request_token: cart.shippingRequestToken,
            shipping_courier_id: cart.shippingCourierId,
            shipping_service_code: cart.shippingServiceCode,
            shipping_quote_id: cart.shippingQuoteId,
            shipping_currency: cart.shippingCurrency,
            shipping_quotes:
              cart.shippingQuotes.length > 0
                ? JSON.stringify(cart.shippingQuotes)
                : null,
            shipping_quote_fingerprint: cart.shippingQuoteFingerprint,
            insurance_amount_minor: cart.insuranceAmountMinor,
            version: cart.version,
            metadata: JSON.stringify(cart.metadata),
            frozen: cart.frozen,
            frozen_reason: cart.frozenReason,
            frozen_at: cart.frozenAt,
            order_id: cart.orderId,
            converted_at: cart.convertedAt,
            status: cart.status,
            payment_status: cart.paymentStatus,
            payment_initialized: cart.paymentInitialized,
            payment_authorization_url: cart.paymentAuthorizationUrl,
            payment_initialized_at: cart.paymentInitializedAt,
            payment_reference: cart.paymentReference,
            created_at: cart.createdAt,
            updated_at: cart.updatedAt,
          })
          .execute();
      }

      // The aggregate's version was persisted; treat it as the new baseline
      // (fail-closed: if the surrounding transaction rolls back, the next save
      // compares against a version that no longer exists and is rejected).
      cart.acknowledgePersisted();

      // Replace the line-item set so children mirror the aggregate's items.
      await db.deleteFrom("cart_line_item").where("cart_id", "=", cart.id).execute();

      if (cart.items.length > 0) {
        await db
          .insertInto("cart_line_item")
          .values(
            cart.items.map((item) => ({
              id: item.id,
              cart_id: item.cartId,
              variant_id: item.variantId,
              title: item.title ?? null,
              quantity: item.quantity,
              unit_price_minor: item.unitPriceMinor,
              metadata: JSON.stringify(item.metadata),
              created_at: item.createdAt,
            })),
          )
          .execute();
      }
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async delete(cartId: string): Promise<void> {
    try {
      const db = this.context.getDb();
      await db.deleteFrom("cart_line_item").where("cart_id", "=", cartId).execute();
      await db.deleteFrom("cart").where("id", "=", cartId).execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async deleteAbandonedCarts(expirationDateThreshold: Date): Promise<number> {
    try {
      // A cart is "abandoned" when it has not been mutated since the threshold
      // (updated_at), not merely since it was created (created_at), so active
      // carts that were recently touched are never pruned.
      const result = await this.context
        .getDb()
        .deleteFrom("cart")
        .where("status", "=", "active")
        .where("order_id", "is", null)
        .where("updated_at", "<", expirationDateThreshold.toISOString())
        .execute();

      return Number(result[0]?.numDeletedRows ?? 0);
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
