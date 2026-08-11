// apps/api/src/infrastructure/database/repositories/PostgresProductReadRepository.ts

// Postgres-backed implementation of IProductReadRepository.
//
// Read-only catalog projection enforcing visibility: a product is visible in a
// region only when at least one of its variants has a money_amount priced for
// that region, and — when a sales channel is given — only when the product is
// explicitly assigned to that channel via the `product_sales_channel` join
// table. An optional `categoryId` filter restricts results to products assigned
// to that category via `product_category`. Returned products are hydrated with
// their category/sales-channel membership. `expand`/`fields` are accepted for
// interface compatibility but the projection always returns full Product
// entities with their variants.

import { Product } from "@api/domain/entities/Product";
import { ProductVariant } from "@api/domain/entities/ProductVariant";
import type { ProductReadQuery } from "@api/domain/shared/contracts";
import type { IProductReadRepository } from "@api-domain-interfaces/repositories/IProductReadRepository";
import type { Expression, ExpressionBuilder, Kysely } from "kysely";
import { TransactionContext } from "../transaction/TransactionContext";
import type { Database } from "../schema/types";
import { toRepositoryError } from "./errorMapping";

type ProductRow = {
  id: string;
  title: string;
  handle: string;
  description: string | null;
};

type VariantRow = {
  id: string;
  product_id: string;
  sku: string;
  inventory_quantity: number;
  allow_backorder: boolean;
  version: number;
};

function toProductDomain(row: ProductRow): Product {
  return new Product({
    id: row.id,
    title: row.title,
    handle: row.handle,
    description: row.description ?? undefined,
  });
}

function toVariantDomain(row: VariantRow): ProductVariant {
  return new ProductVariant({
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    inventoryQuantity: row.inventory_quantity,
    allowBackorder: row.allow_backorder,
    version: row.version,
  });
}

// Normalizes the optional free-form search term (query.q or query.searchQuery).
function toSearchQuery(query: ProductReadQuery): string | null {
  const raw = (query.q ?? query.searchQuery) as unknown;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

// Loads category/sales-channel membership for a set of products in two batched
// queries (avoiding a per-product N+1).
async function loadMemberships(
  db: Kysely<Database>,
  productIds: string[],
): Promise<Map<string, { categoryIds: string[]; salesChannelIds: string[] }>> {
  const result = new Map<
    string,
    { categoryIds: string[]; salesChannelIds: string[] }
  >();
  if (productIds.length === 0) {
    return result;
  }

  const [categoryRows, salesChannelRows] = await Promise.all([
    db
      .selectFrom("product_category")
      .select(["product_id", "category_id"])
      .where("product_id", "in", productIds)
      .execute(),
    db
      .selectFrom("product_sales_channel")
      .select(["product_id", "sales_channel_id"])
      .where("product_id", "in", productIds)
      .execute(),
  ]);

  for (const row of categoryRows) {
    const entry = result.get(row.product_id) ?? {
      categoryIds: [],
      salesChannelIds: [],
    };
    entry.categoryIds.push(row.category_id);
    result.set(row.product_id, entry);
  }
  for (const row of salesChannelRows) {
    const entry = result.get(row.product_id) ?? {
      categoryIds: [],
      salesChannelIds: [],
    };
    entry.salesChannelIds.push(row.sales_channel_id);
    result.set(row.product_id, entry);
  }
  return result;
}

export class PostgresProductReadRepository implements IProductReadRepository {
  constructor(private readonly context: TransactionContext) {}

  async findMany(
    query: ProductReadQuery,
  ): Promise<{ items: Product[]; total: number }> {
    try {
      const db = this.context.getDb();

      const regionId = typeof query.regionId === "string" ? query.regionId : "";
      const salesChannelId =
        typeof query.salesChannelId === "string" ? query.salesChannelId : "";
      const categoryId =
        typeof query.categoryId === "string" && query.categoryId.trim() !== ""
          ? query.categoryId.trim()
          : "";
      const searchQuery = toSearchQuery(query);
      const limit = Math.max(1, Math.min(query.limit ?? 20, 200));
      const offset = Math.max(0, query.offset ?? 0);

      // Build the visibility condition: regional price exists, optional sales
      // channel / category membership, and optional search term.
      const visibility = (
        eb: ExpressionBuilder<Database, "product">,
      ): ReturnType<ExpressionBuilder<Database, "product">["and"]> => {
        const clauses: Expression<any>[] = [];

        if (searchQuery) {
          const q = `%${searchQuery}%`;
          clauses.push(
            eb.or([
              eb("product.title", "ilike", q),
              eb("product.handle", "ilike", q),
            ]),
          );
        }

        clauses.push(
          eb.exists(
            eb
              .selectFrom("money_amount")
              .innerJoin(
                "product_variant",
                "product_variant.id",
                "money_amount.variant_id",
              )
              .whereRef("product_variant.product_id", "=", "product.id")
              .where("money_amount.region_id", "=", regionId),
          ),
        );

        if (salesChannelId) {
          clauses.push(
            eb.exists(
              eb
                .selectFrom("product_sales_channel")
                .whereRef(
                  "product_sales_channel.product_id",
                  "=",
                  "product.id",
                )
                .where(
                  "product_sales_channel.sales_channel_id",
                  "=",
                  salesChannelId,
                ),
            ),
          );
        }

        if (categoryId) {
          clauses.push(
            eb.exists(
              eb
                .selectFrom("product_category")
                .whereRef("product_category.product_id", "=", "product.id")
                .where("product_category.category_id", "=", categoryId),
            ),
          );
        }

        return eb.and(clauses);
      };

      const totalResult = await db
        .selectFrom("product")
        .where(visibility)
        .select(db.fn.countAll().as("count"))
        .executeTakeFirst();

      const total = Number(totalResult?.count ?? 0);

      const productRows = await db
        .selectFrom("product")
        .selectAll()
        .where(visibility)
        .orderBy("handle")
        .limit(limit)
        .offset(offset)
        .execute();

      const memberships = await loadMemberships(
        db,
        productRows.map((p) => p.id),
      );

      const products: Product[] = [];
      for (const productRow of productRows) {
        const variantRows = await db
          .selectFrom("product_variant")
          .selectAll()
          .where("product_id", "=", productRow.id)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom("money_amount")
                .whereRef("money_amount.variant_id", "=", "product_variant.id")
                .where("money_amount.region_id", "=", regionId),
            ),
          )
          .execute();

        const membership = memberships.get(productRow.id) ?? {
          categoryIds: [],
          salesChannelIds: [],
        };
        const product = toProductDomain(productRow);
        product.assignCategories(membership.categoryIds);
        product.assignSalesChannels(membership.salesChannelIds);
        variantRows.forEach((variantRow) =>
          product.addVariant(toVariantDomain(variantRow)),
        );
        products.push(product);
      }

      return { items: products, total };
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByIdAndContext(
    productId: string,
    salesChannelId: string,
    regionId: string,
    expand?: string[],
    fields?: string[],
  ): Promise<Product | null> {
    try {
      const db = this.context.getDb();

      const productRow = await db
        .selectFrom("product")
        .selectAll()
        .where("id", "=", productId)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("money_amount")
              .innerJoin(
                "product_variant",
                "product_variant.id",
                "money_amount.variant_id",
              )
              .whereRef("product_variant.product_id", "=", "product.id")
              .where("money_amount.region_id", "=", regionId),
          ),
        )
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("product_sales_channel")
              .whereRef("product_sales_channel.product_id", "=", "product.id")
              .where(
                "product_sales_channel.sales_channel_id",
                "=",
                salesChannelId,
              ),
          ),
        )
        .executeTakeFirst();

      if (!productRow) {
        return null;
      }

      const membership = await loadMemberships(db, [productRow.id]);
      const product = toProductDomain(productRow);
      const memberOf = membership.get(product.id) ?? {
        categoryIds: [],
        salesChannelIds: [],
      };
      product.assignCategories(memberOf.categoryIds);
      product.assignSalesChannels(memberOf.salesChannelIds);

      // Always hydrate variants when asked to expand them or by default for a
      // usable projection; the interface's expand/fields are accepted but not
      // selectively applied (schema cannot support fine-grained projections).
      const includeVariants =
        expand === undefined ||
        expand.length === 0 ||
        expand.includes("variants") ||
        expand.includes("variants.options");

      if (includeVariants) {
        const variantRows = await db
          .selectFrom("product_variant")
          .selectAll()
          .where("product_id", "=", product.id)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom("money_amount")
                .whereRef("money_amount.variant_id", "=", "product_variant.id")
                .where("money_amount.region_id", "=", regionId),
            ),
          )
          .execute();

        variantRows.forEach((variantRow) =>
          product.addVariant(toVariantDomain(variantRow)),
        );
      }

      return product;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
