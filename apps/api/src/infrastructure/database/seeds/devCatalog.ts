// apps/api/src/infrastructure/database/seeds/devCatalog.ts
//
// F4 PRE-IMPLEMENTATION (M1/PART 4) — DEVELOPMENT-ONLY CATALOG SEED.
//
// Smallest development mechanism that makes the new media/category projection
// testable and gives the storefront valid browse data against a real backend.
// It is NOT a schema migration and inserts NO fake production data into the
// production migration history: it runs explicitly via
//   pnpm --filter @clothing-line-project/api db:seed:dev
//
// REQUIRES the schema migrations (incl. 0019 provisioning reg-storefront /
// channel-storefront and loc-default from 0016) to have been applied.
//
// Deterministic ids + ON CONFLICT DO NOTHING keep the seed idempotent (safe to
// re-run). Products are assigned to the provisioned default sales channel and
// priced in the provisioned default NGN region; inventory_level rows point at
// the default fulfillment location. Media urls are RELATIVE asset paths (no
// external image hosting required to pass automated tests).

import { Kysely } from "kysely";
import { db } from "../connection/kysely";

// Canonical provisioning ids (migrations 0016 + 0019).
const DEFAULT_LOCATION_ID = "loc-default";
const DEFAULT_REGION_ID = "reg-storefront";
const DEFAULT_CHANNEL_ID = "channel-storefront";

interface SeedMedia {
  id: string;
  url: string;
  kind: string;
  altText: string | null;
  sortOrder: number;
}

interface SeedVariant {
  id: string;
  sku: string;
  inventoryQuantity: number;
  allowBackorder: boolean;
  priceMinor: number;
}

interface SeedProduct {
  id: string;
  title: string;
  handle: string;
  description: string;
  categoryId: string;
  categoryName: string;
  variants: SeedVariant[];
  media: SeedMedia[];
}

const PRODUCTS: SeedProduct[] = [
  {
    id: "dev-shadow-work-jacket",
    title: "Shadow Work Jacket",
    handle: "shadow-work-jacket",
    description:
      "Waxed-cotton chore jacket with triple-needle stitching. Full sleeves, boxy fit.",
    categoryId: "dev-cat-jackets",
    categoryName: "Jackets",
    variants: [
      { id: "dev-v-shadow-s", sku: "GW-JK-001-S", inventoryQuantity: 4, allowBackorder: false, priceMinor: 45000 },
      { id: "dev-v-shadow-m", sku: "GW-JK-001-M", inventoryQuantity: 6, allowBackorder: false, priceMinor: 45000 },
      { id: "dev-v-shadow-l", sku: "GW-JK-001-L", inventoryQuantity: 0, allowBackorder: false, priceMinor: 45000 },
    ],
    media: [
      { id: "dev-m-shadow-1", url: "/products/shadow-work-jacket-1.jpg", kind: "image", altText: "Shadow Work Jacket front", sortOrder: 0 },
      { id: "dev-m-shadow-2", url: "/products/shadow-work-jacket-2.jpg", kind: "image", altText: "Shadow Work Jacket back", sortOrder: 1 },
    ],
  },
  {
    id: "dev-cutoff-utility-vest",
    title: "Cutoff Utility Vest",
    handle: "cutoff-utility-vest",
    description: "Sleeveless canvas vest with mapped chest pockets and a raw hem.",
    categoryId: "dev-cat-jackets",
    categoryName: "Jackets",
    variants: [
      { id: "dev-v-vest-s", sku: "GW-JK-002-S", inventoryQuantity: 8, allowBackorder: false, priceMinor: 28000 },
      { id: "dev-v-vest-m", sku: "GW-JK-002-M", inventoryQuantity: 5, allowBackorder: false, priceMinor: 28000 },
      { id: "dev-v-vest-l", sku: "GW-JK-002-L", inventoryQuantity: 3, allowBackorder: false, priceMinor: 28000 },
    ],
    media: [
      { id: "dev-m-vest-1", url: "/products/cutoff-utility-vest-1.jpg", kind: "image", altText: "Cutoff Utility Vest", sortOrder: 0 },
    ],
  },
  {
    id: "dev-signal-cuff",
    title: "Signal Cuff",
    handle: "signal-cuff",
    description: "Solid, hand-finished cuff with a brushed face.",
    categoryId: "dev-cat-jewelry",
    categoryName: "Jewelry",
    variants: [
      { id: "dev-v-cuff-os", sku: "GW-JW-001-OS", inventoryQuantity: 5, allowBackorder: false, priceMinor: 32000 },
    ],
    media: [
      { id: "dev-m-cuff-1", url: "/products/signal-cuff-1.jpg", kind: "image", altText: "Signal Cuff", sortOrder: 0 },
    ],
  },
  {
    id: "dev-monolith-signet-ring",
    title: "Monolith Signet Ring",
    handle: "monolith-ring",
    description: "Heavy sterling signet with a brushed monolith face.",
    categoryId: "dev-cat-jewelry",
    categoryName: "Jewelry",
    variants: [
      { id: "dev-v-ring-os", sku: "GW-JW-003-OS", inventoryQuantity: 7, allowBackorder: false, priceMinor: 54000 },
    ],
    media: [
      { id: "dev-m-ring-1", url: "/products/monolith-signet-ring-1.jpg", kind: "image", altText: "Monolith Signet Ring", sortOrder: 0 },
    ],
  },
  {
    id: "dev-ridgeback-belt",
    title: "Ridgeback Belt",
    handle: "ridgeback-belt",
    description: "Vegetable-tanned leather belt with a solid brass buckle.",
    categoryId: "dev-cat-accessories",
    categoryName: "Accessories",
    variants: [
      { id: "dev-v-belt-s", sku: "GW-AC-001-S", inventoryQuantity: 10, allowBackorder: false, priceMinor: 18000 },
      { id: "dev-v-belt-m", sku: "GW-AC-001-M", inventoryQuantity: 8, allowBackorder: false, priceMinor: 18000 },
    ],
    media: [
      { id: "dev-m-belt-1", url: "/products/ridgeback-belt-1.jpg", kind: "image", altText: "Ridgeback Belt", sortOrder: 0 },
      { id: "dev-m-belt-2", url: "/products/ridgeback-belt-2.jpg", kind: "image", altText: "Ridgeback Belt detail", sortOrder: 1 },
    ],
  },
];

async function seedProduct(db: Kysely<any>, product: SeedProduct): Promise<void> {
  // Category row (idempotent).
  await db
    .insertInto("category")
    .values({ id: product.categoryId, name: product.categoryName, parent_category_id: null })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();

  // Product row.
  await db
    .insertInto("product")
    .values({ id: product.id, title: product.title, handle: product.handle, description: product.description })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();

  // Category + sales-channel membership.
  await db
    .insertInto("product_category")
    .values({ product_id: product.id, category_id: product.categoryId })
    .onConflict((oc) => oc.columns(["product_id", "category_id"]).doNothing())
    .execute();
  await db
    .insertInto("product_sales_channel")
    .values({ product_id: product.id, sales_channel_id: DEFAULT_CHANNEL_ID })
    .onConflict((oc) => oc.columns(["product_id", "sales_channel_id"]).doNothing())
    .execute();

  // Variants + regional price + inventory level.
  for (const variant of product.variants) {
    await db
      .insertInto("product_variant")
      .values({
        id: variant.id,
        product_id: product.id,
        sku: variant.sku,
        inventory_quantity: variant.inventoryQuantity,
        allow_backorder: variant.allowBackorder,
        version: 1,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await db
      .insertInto("money_amount")
      .values({
        id: `dev-ma-${variant.id}`,
        variant_id: variant.id,
        region_id: DEFAULT_REGION_ID,
        amount_minor: variant.priceMinor,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await db
      .insertInto("inventory_level")
      .values({
        id: `dev-il-${variant.id}`,
        variant_id: variant.id,
        location_id: DEFAULT_LOCATION_ID,
        available_quantity: variant.inventoryQuantity,
        reserved_quantity: 0,
        version: 1,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  }

  // Media references.
  for (const media of product.media) {
    await db
      .insertInto("product_media")
      .values({
        id: media.id,
        product_id: product.id,
        url: media.url,
        kind: media.kind,
        alt_text: media.altText,
        sort_order: media.sortOrder,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  }
}

async function main(): Promise<void> {
  for (const product of PRODUCTS) {
    await seedProduct(db, product);
    console.log(`  seeded ${product.handle}`);
  }
  console.log(
    `Dev catalog seeded: ${PRODUCTS.length} products (region=${DEFAULT_REGION_ID}, channel=${DEFAULT_CHANNEL_ID}, location=${DEFAULT_LOCATION_ID}).`,
  );
}

main()
  .then(() => db.destroy())
  .catch(async (error) => {
    console.error(error);
    await db.destroy();
    process.exitCode = 1;
  });