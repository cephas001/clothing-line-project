// apps/api/src/infrastructure/database/migrations/0001_initial_schema.ts
//
// Initial relational schema. Tables and columns mirror `../types.ts` exactly
// (itself derived from the domain model under apps/api/src/domain).
//
// Conventions:
//   - `id` (text UUID) is always application-generated via IIdGenerator, so it
//     is a plain text primary key; inserts always supply it.
//   - `created_at` / `updated_at` use the SQL default `now()`.
//   - Monetary values are stored as BIGINT minor units (Kobo/cents) — the
//     domain caps (e.g. 100_000_000_000) exceed INT4 range. The pg driver is
//     configured to parse INT8 back into JS `number` (see ../kysely.ts).
//   - Percentages/rates are preserved as integer basis points (INTEGER).
//   - Collection value objects (addresses, members, proposed changes, items,
//     provider lists) are stored as JSONB and typed against the domain shapes
//     they serialize (see domain/shared/contracts.ts). Genuine relational
//     children (line items, transactions, money amounts) are normalized into
//     their own tables with foreign keys.
//
// Circular references (customer.active_cart_id -> cart, cart.order_id -> order)
// cannot be declared inline, so their constraints are appended at the end of
// this migration once every table exists.
//
// Down migration drops tables in reverse dependency order with CASCADE.

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // ---------------------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------------------

  await db.schema
    .createTable("region")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("currency_code", "text", (col) => col.notNull())
    .addColumn("tax_rate", "integer", (col) => col.notNull())
    .addColumn("payment_providers", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn("fulfillment_providers", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .execute();

  await db.schema
    .createTable("sales_channel")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("is_disabled", "boolean", (col) =>
      col.notNull().defaultTo(sql`false`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable("product")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("handle", "text", (col) => col.notNull().unique())
    .addColumn("description", "text")
    .execute();

  await db.schema
    .createTable("product_variant")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("product_id", "text", (col) =>
      col.references("product.id").notNull(),
    )
    .addColumn("sku", "text", (col) => col.notNull().unique())
    .addColumn("inventory_quantity", "integer", (col) => col.notNull())
    .addColumn("allow_backorder", "boolean", (col) => col.notNull())
    .addColumn("version", "integer", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .execute();

  await db.schema
    .createTable("money_amount")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("variant_id", "text", (col) =>
      col.references("product_variant.id").notNull(),
    )
    .addColumn("region_id", "text", (col) =>
      col.references("region.id").notNull(),
    )
    .addColumn("amount_minor", "bigint", (col) => col.notNull())
    .addUniqueConstraint("money_amount_variant_region_unique", [
      "variant_id",
      "region_id",
    ])
    .execute();

  await db.schema
    .createTable("category")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("parent_category_id", "text", (col) =>
      col.references("category.id"),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable("collection")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("title", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("tax_category")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("region_id", "text", (col) =>
      col.references("region.id").notNull(),
    )
    .addColumn("rate", "integer", (col) => col.notNull())
    .addUniqueConstraint("tax_category_name_region_unique", [
      "name",
      "region_id",
    ])
    .execute();

  // ---------------------------------------------------------------------------
  // Customers & auth
  // ---------------------------------------------------------------------------

  await db.schema
    .createTable("role")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("permissions", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .execute();

  // active_cart_id FK is appended at the end (circular: points to cart).
  await db.schema
    .createTable("customer")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("first_name", "text", (col) => col.notNull())
    .addColumn("last_name", "text", (col) => col.notNull())
    .addColumn("email", "text", (col) => col.notNull().unique())
    .addColumn("active_cart_id", "text")
    .addColumn("password_hash", "text")
    .addColumn("registered_at", "timestamptz")
    .addColumn("phone", "text")
    .addColumn("addresses", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn("security_stamp", "text")
    .addColumn("password_updated_at", "timestamptz")
    .addColumn("failed", "integer")
    .addColumn("last_failed_at", "timestamptz")
    .addColumn("lock_until", "timestamptz")
    .addColumn("last_login_at", "timestamptz")
    .addColumn("disabled", "boolean", (col) =>
      col.notNull().defaultTo(sql`false`),
    )
    .addColumn("roles", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn("password_reset_token_id", "text")
    .addColumn("password_reset_token_hash", "text")
    .addColumn("password_reset_requested_at", "timestamptz")
    .addColumn("password_reset_expires_at", "timestamptz")
    .addColumn("metadata", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .execute();

  // ---------------------------------------------------------------------------
  // Cart
  // ---------------------------------------------------------------------------

  // order_id FK is appended at the end (circular: points to order).
  await db.schema
    .createTable("cart")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("region_id", "text", (col) =>
      col.references("region.id").notNull(),
    )
    .addColumn("sales_channel_id", "text", (col) =>
      col.references("sales_channel.id").notNull(),
    )
    .addColumn("customer_id", "text", (col) => col.references("customer.id"))
    .addColumn("email", "text")
    .addColumn("country_code", "text")
    .addColumn("shipping_address", "jsonb")
    .addColumn("discount", "jsonb")
    .addColumn("tax_amount_minor", "bigint")
    .addColumn("metadata", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("frozen", "boolean", (col) =>
      col.notNull().defaultTo(sql`false`),
    )
    .addColumn("frozen_reason", "text")
    .addColumn("frozen_at", "timestamptz")
    .addColumn("order_id", "text")
    .addColumn("converted_at", "timestamptz")
    .addColumn("status", "text", (col) =>
      col.notNull().defaultTo(sql`'active'`),
    )
    .addColumn("payment_status", "text", (col) =>
      col.notNull().defaultTo(sql`'pending'`),
    )
    .addColumn("payment_initialized", "boolean", (col) =>
      col.notNull().defaultTo(sql`false`),
    )
    .addColumn("payment_authorization_url", "text")
    .addColumn("payment_initialized_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable("cart_line_item")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("cart_id", "text", (col) =>
      col.references("cart.id").notNull().onDelete("cascade"),
    )
    .addColumn("variant_id", "text", (col) =>
      col.references("product_variant.id"),
    )
    .addColumn("title", "text")
    .addColumn("quantity", "integer", (col) => col.notNull())
    .addColumn("unit_price_minor", "bigint", (col) => col.notNull())
    .addColumn("metadata", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // ---------------------------------------------------------------------------
  // Checkout & orders
  // ---------------------------------------------------------------------------

  await db.schema
    .createTable("order")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("cart_id", "text", (col) =>
      col.references("cart.id").notNull(),
    )
    .addColumn("customer_id", "text", (col) =>
      col.references("customer.id").notNull(),
    )
    .addColumn("total_minor", "bigint", (col) => col.notNull())
    .addColumn("fulfillment_status", "text", (col) =>
      col.notNull().defaultTo(sql`'unfulfilled'`),
    )
    .addColumn("payment_status", "text", (col) =>
      col.notNull().defaultTo(sql`'pending'`),
    )
    .addColumn("transaction_reference", "text", (col) => col.unique())
    .addColumn("payment_status_reason", "text")
    .addColumn("payment_status_updated_at", "timestamptz")
    .addColumn("flagged_for_review", "boolean", (col) =>
      col.notNull().defaultTo(sql`false`),
    )
    .addColumn("flag_reason", "text")
    .addColumn("risk_score", "integer")
    .addColumn("flagged_at", "timestamptz")
    .addColumn("fulfillment_halted_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable("order_line_item")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("order_id", "text", (col) =>
      col.references("order.id").notNull().onDelete("cascade"),
    )
    .addColumn("variant_id", "text", (col) =>
      col.references("product_variant.id"),
    )
    .addColumn("quantity", "integer", (col) => col.notNull())
    .addColumn("unit_price_minor", "bigint", (col) => col.notNull())
    .addColumn("fulfilled_quantity", "integer")
    .execute();

  await db.schema
    .createTable("transaction")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("order_id", "text", (col) =>
      col.references("order.id").notNull(),
    )
    .addColumn("amount_minor", "bigint", (col) => col.notNull())
    .addColumn("reference", "text", (col) => col.notNull().unique())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable("order_edit")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("order_id", "text", (col) =>
      col.references("order.id").notNull(),
    )
    .addColumn("action_type", "text", (col) => col.notNull())
    .addColumn("reason", "text")
    .addColumn("proposed_changes", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn("status", "text", (col) =>
      col.notNull().defaultTo(sql`'draft'`),
    )
    .addColumn("difference_due_minor", "bigint", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .addColumn("created_by", "text")
    .addColumn("created_at", "timestamptz")
    .addColumn("confirmed_by", "text")
    .addColumn("confirmed_at", "timestamptz")
    .addColumn("payment_reference", "text")
    .execute();

  await db.schema
    .createTable("promotion")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("code", "text", (col) => col.notNull().unique())
    .addColumn("discount_type", "text", (col) => col.notNull())
    .addColumn("discount_value_minor", "bigint", (col) => col.notNull())
    .addColumn("minimum_spend_minor", "bigint", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .addColumn("is_active", "boolean", (col) =>
      col.notNull().defaultTo(sql`true`),
    )
    .execute();

  // ---------------------------------------------------------------------------
  // Fulfillment, returns & swaps
  // ---------------------------------------------------------------------------

  await db.schema
    .createTable("fulfillment")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("order_id", "text", (col) =>
      col.references("order.id").notNull(),
    )
    .addColumn("tracking_number", "text", (col) => col.notNull())
    .addColumn("courier", "text")
    .addColumn("label_url", "text")
    .addColumn("service_level", "text")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("metadata", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable("return_authorization")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("order_id", "text", (col) =>
      col.references("order.id").notNull(),
    )
    .addColumn("items", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn("refund_amount_minor", "bigint", (col) => col.notNull())
    .addColumn("status", "text", (col) =>
      col.notNull().defaultTo(sql`'pending'`),
    )
    .addColumn("shipping_label_url", "text")
    .addColumn("requested_by_customer_id", "text", (col) =>
      col.references("customer.id"),
    )
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("metadata", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .execute();

  await db.schema
    .createTable("swap")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("order_id", "text", (col) =>
      col.references("order.id").notNull(),
    )
    .addColumn("return_line_item_id", "text", (col) => col.notNull())
    .addColumn("return_quantity", "integer", (col) => col.notNull())
    .addColumn("new_variant_id", "text", (col) =>
      col.references("product_variant.id").notNull(),
    )
    .addColumn("new_variant_price_minor", "bigint", (col) => col.notNull())
    .addColumn("original_value_minor", "bigint", (col) => col.notNull())
    .addColumn("difference_minor", "bigint", (col) => col.notNull())
    .addColumn("status", "text", (col) =>
      col.notNull().defaultTo(sql`'pending'`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("payment_reference", "text")
    .addColumn("payment_url", "text")
    .execute();

  // ---------------------------------------------------------------------------
  // B2B
  // ---------------------------------------------------------------------------

  await db.schema
    .createTable("business_unit")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("registration_number", "text", (col) => col.notNull().unique())
    .addColumn("sales_channel_id", "text", (col) =>
      col.references("sales_channel.id").notNull(),
    )
    .addColumn("members", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable("quote")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("cart_id", "text", (col) => col.references("cart.id").notNull())
    .addColumn("cart_snapshot_json", "text", (col) => col.notNull())
    .addColumn("business_unit_id", "text", (col) =>
      col.references("business_unit.id").notNull(),
    )
    .addColumn("requested_by_customer_id", "text", (col) =>
      col.references("customer.id").notNull(),
    )
    .addColumn("requested_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("status", "text", (col) =>
      col.notNull().defaultTo(sql`'PENDING_APPROVAL'`),
    )
    .addColumn("notes", "text")
    .addColumn("approved_total_minor", "bigint")
    .addColumn("approved_by", "text")
    .addColumn("approved_at", "timestamptz")
    .addColumn("approval_note", "text")
    .execute();

  await db.schema
    .createTable("draft_order")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("email", "text", (col) => col.notNull())
    .addColumn("items", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn("shipping_address", "jsonb")
    .addColumn("total_minor", "bigint", (col) => col.notNull())
    .addColumn("status", "text", (col) =>
      col.notNull().defaultTo(sql`'awaiting_payment'`),
    )
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("metadata", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .execute();

  // ---------------------------------------------------------------------------
  // Community
  // ---------------------------------------------------------------------------

  await db.schema
    .createTable("review")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("product_id", "text", (col) =>
      col.references("product.id").notNull(),
    )
    .addColumn("customer_id", "text", (col) =>
      col.references("customer.id").notNull(),
    )
    .addColumn("rating", "integer", (col) => col.notNull())
    .addColumn("comment", "text")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint("review_product_customer_unique", [
      "product_id",
      "customer_id",
    ])
    .execute();

  // ---------------------------------------------------------------------------
  // Circular foreign keys (resolved now that all tables exist)
  // ---------------------------------------------------------------------------

  await db.schema
    .alterTable("customer")
    .addForeignKeyConstraint(
      "customer_active_cart_id_fk",
      ["active_cart_id"],
      "cart",
      ["id"],
    )
    .execute();

  await db.schema
    .alterTable("cart")
    .addForeignKeyConstraint(
      "cart_order_id_fk",
      ["order_id"],
      "order",
      ["id"],
    )
    .execute();

  // ---------------------------------------------------------------------------
  // Indexes for hot lookup paths
  // ---------------------------------------------------------------------------

  await db.schema
    .createIndex("product_variant_product_id_idx")
    .on("product_variant")
    .column("product_id")
    .execute();

  await db.schema
    .createIndex("cart_customer_id_idx")
    .on("cart")
    .column("customer_id")
    .execute();

  await db.schema
    .createIndex("cart_line_item_cart_id_idx")
    .on("cart_line_item")
    .column("cart_id")
    .execute();

  await db.schema
    .createIndex("order_customer_id_idx")
    .on("order")
    .column("customer_id")
    .execute();

  await db.schema
    .createIndex("order_line_item_order_id_idx")
    .on("order_line_item")
    .column("order_id")
    .execute();

  await db.schema
    .createIndex("transaction_order_id_idx")
    .on("transaction")
    .column("order_id")
    .execute();

  await db.schema
    .createIndex("fulfillment_order_id_idx")
    .on("fulfillment")
    .column("order_id")
    .execute();

  await db.schema
    .createIndex("fulfillment_tracking_number_idx")
    .on("fulfillment")
    .column("tracking_number")
    .execute();

  await db.schema
    .createIndex("return_authorization_order_id_idx")
    .on("return_authorization")
    .column("order_id")
    .execute();

  await db.schema
    .createIndex("swap_order_id_idx")
    .on("swap")
    .column("order_id")
    .execute();

  await db.schema
    .createIndex("quote_business_unit_id_idx")
    .on("quote")
    .column("business_unit_id")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  const tables = [
    "review",
    "draft_order",
    "quote",
    "business_unit",
    "swap",
    "return_authorization",
    "fulfillment",
    "promotion",
    "order_edit",
    "transaction",
    "order_line_item",
    "order",
    "cart_line_item",
    "cart",
    "customer",
    "role",
    "tax_category",
    "collection",
    "category",
    "money_amount",
    "product_variant",
    "product",
    "sales_channel",
    "region",
  ];

  for (const table of tables) {
    await db.schema.dropTable(table).cascade().execute();
  }
}
