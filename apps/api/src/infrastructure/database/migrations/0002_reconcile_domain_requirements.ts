// apps/api/src/infrastructure/database/migrations/0002_reconcile_domain_requirements.ts
//
// Reconcilies the relational schema with domain requirements that had no
// persistence home in `0001_initial_schema.ts`:
//
//   - `customer.password_reset_request_ip` — records the IP that issued the
//     password reset (InitiatePasswordResetUseCase -> ICustomerRepository).
//   - `cart.updated_at` — tracks the last mutation so abandoned carts are
//     pruned by activity (PruneAbandonedCartsUseCase), not by creation time.
//   - `order.promotion_snapshot` — persists the frozen PromotionSnapshot
//     recorded at checkout (FinalizeOrderTransactionUseCase).
//   - `product_category` / `product_sales_channel` — normalized join tables for
//     the Product aggregate's many-to-many category/sales-channel membership so
//     catalog visibility (IProductReadRepository) can be enforced in SQL.
//
// All additions are additive; existing rows are preserved. `cart.updated_at`
// defaults to `now()` so pre-existing carts are not retroactively treated as
// abandoned.
//
// Down migration reverses the additions.

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Customer: record the request IP of the most recent password reset.
  await db.schema
    .alterTable("customer")
    .addColumn("password_reset_request_ip", "text")
    .execute();

  // Cart: last-mutation timestamp for abandonment pruning.
  await db.schema
    .alterTable("cart")
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // Order: frozen financial snapshot of the applied promotion.
  await db.schema
    .alterTable("order")
    .addColumn("promotion_snapshot", "jsonb")
    .execute();

  // Product <-> Category (many-to-many) join table.
  await db.schema
    .createTable("product_category")
    .addColumn("product_id", "text", (col) =>
      col.references("product.id").onDelete("cascade").notNull(),
    )
    .addColumn("category_id", "text", (col) =>
      col.references("category.id").onDelete("cascade").notNull(),
    )
    .addPrimaryKeyConstraint("product_category_pkey", [
      "product_id",
      "category_id",
    ])
    .execute();

  await db.schema
    .createIndex("product_category_product_id_idx")
    .on("product_category")
    .column("product_id")
    .execute();

  await db.schema
    .createIndex("product_category_category_id_idx")
    .on("product_category")
    .column("category_id")
    .execute();

  // Product <-> SalesChannel (many-to-many) join table.
  await db.schema
    .createTable("product_sales_channel")
    .addColumn("product_id", "text", (col) =>
      col.references("product.id").onDelete("cascade").notNull(),
    )
    .addColumn("sales_channel_id", "text", (col) =>
      col.references("sales_channel.id").onDelete("cascade").notNull(),
    )
    .addPrimaryKeyConstraint("product_sales_channel_pkey", [
      "product_id",
      "sales_channel_id",
    ])
    .execute();

  await db.schema
    .createIndex("product_sales_channel_product_id_idx")
    .on("product_sales_channel")
    .column("product_id")
    .execute();

  await db.schema
    .createIndex("product_sales_channel_sales_channel_id_idx")
    .on("product_sales_channel")
    .column("sales_channel_id")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("product_sales_channel").execute();
  await db.schema.dropTable("product_category").execute();
  await db.schema
    .alterTable("order")
    .dropColumn("promotion_snapshot")
    .execute();
  await db.schema.alterTable("cart").dropColumn("updated_at").execute();
  await db.schema
    .alterTable("customer")
    .dropColumn("password_reset_request_ip")
    .execute();
}
