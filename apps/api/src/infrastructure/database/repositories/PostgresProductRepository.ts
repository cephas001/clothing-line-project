// apps/api/src/infrastructure/database/repositories/PostgresProductRepository.ts

// Postgres-backed implementation of IProductRepository.
//
// Persists the product aggregate root plus its many-to-many category and
// sales-channel membership via the `product_category` / `product_sales_channel`
// join tables: save() upserts the product row, then replaces both membership
// sets (delete + reinsert) so children always mirror the aggregate. Variants
// are owned and written by IVariantRepository, keeping each repository
// responsible for its own tables. The product table carries no created_at
// column, so reads order by handle.

import { Product } from "@api-domain-entities/Product";
import type { IProductRepository } from "@api-domain-interfaces/repositories/IProductRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type ProductRow = {
  id: string;
  title: string;
  handle: string;
  description: string | null;
};

function toDomain(row: ProductRow, categoryIds: string[], salesChannelIds: string[]): Product {
  return new Product({
    id: row.id,
    title: row.title,
    handle: row.handle,
    description: row.description ?? undefined,
    categoryIds,
    salesChannelIds,
  });
}

export class PostgresProductRepository implements IProductRepository {
  constructor(private readonly context: TransactionContext) {}

  private async loadMembership(
    productId: string,
  ): Promise<{ categoryIds: string[]; salesChannelIds: string[] }> {
    const db = this.context.getDb();
    const [categoryRows, salesChannelRows] = await Promise.all([
      db
        .selectFrom("product_category")
        .select("category_id")
        .where("product_id", "=", productId)
        .execute(),
      db
        .selectFrom("product_sales_channel")
        .select("sales_channel_id")
        .where("product_id", "=", productId)
        .execute(),
    ]);
    return {
      categoryIds: categoryRows.map((r) => r.category_id),
      salesChannelIds: salesChannelRows.map((r) => r.sales_channel_id),
    };
  }

  async findByHandle(handle: string): Promise<Product | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("product")
        .selectAll()
        .where("handle", "=", handle)
        .executeTakeFirst();

      if (!row) {
        return null;
      }
      const { categoryIds, salesChannelIds } = await this.loadMembership(row.id);
      return toDomain(row, categoryIds, salesChannelIds);
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findById(id: string): Promise<Product | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("product")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

      if (!row) {
        return null;
      }
      const { categoryIds, salesChannelIds } = await this.loadMembership(row.id);
      return toDomain(row, categoryIds, salesChannelIds);
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(product: Product): Promise<void> {
    try {
      const db = this.context.getDb();

      await db
        .insertInto("product")
        .values({
          id: product.id,
          title: product.title,
          handle: product.handle,
          description: product.description,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            title: product.title,
            handle: product.handle,
            description: product.description,
          }),
        )
        .execute();

      // Replace category and sales-channel membership so the persisted joins
      // mirror the aggregate's sets.
      await db
        .deleteFrom("product_category")
        .where("product_id", "=", product.id)
        .execute();
      if (product.categoryIds.length > 0) {
        await db
          .insertInto("product_category")
          .values(
            product.categoryIds.map((categoryId) => ({
              product_id: product.id,
              category_id: categoryId,
            })),
          )
          .execute();
      }

      await db
        .deleteFrom("product_sales_channel")
        .where("product_id", "=", product.id)
        .execute();
      if (product.salesChannelIds.length > 0) {
        await db
          .insertInto("product_sales_channel")
          .values(
            product.salesChannelIds.map((salesChannelId) => ({
              product_id: product.id,
              sales_channel_id: salesChannelId,
            })),
          )
          .execute();
      }
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
