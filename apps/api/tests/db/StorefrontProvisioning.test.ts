// apps/api/tests/db/StorefrontProvisioning.test.ts
//
// REAL-POSTGRES F4 PRE-IMPLEMENTATION TESTS — M3 (default region/sales-channel
// provisioning) and M1 (product category + media projection readiness).
//
//  1. Migration 0019 seeded the canonical storefront context: `reg-storefront`
//     (NGN, 7.5% VAT, Paystack/Shipbubble) and `channel-storefront`. A fresh
//     `POST /store/carts` (InitializeCartSessionUseCase) resolves these via the
//     real repositories — the provisioning blocker is gone.
//  2. Migration 0020 added `product_media`; the read path hydrates media
//     references deterministically (sort_order, then id) so the HTTP projection
//     is stable.
//
// Raw SQL + real repositories drive the real engine (never in-memory fakes).

import { sql } from "kysely";
import type { RawBuilder } from "kysely";
import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { getDbHarness } from "./dbHarness";
import { PostgresRegionRepository } from "@api-infrastructure/database/repositories/PostgresRegionRepository";
import { PostgresSalesChannelRepository } from "@api-infrastructure/database/repositories/PostgresSalesChannelRepository";
import { PostgresProductReadRepository } from "@api-infrastructure/database/repositories/PostgresProductReadRepository";
import { ProductMedia } from "@api/domain/entities/ProductMedia";

function q(raw: string): RawBuilder<unknown> {
  return sql.raw(raw);
}

describe("Real Postgres — default storefront context provisioning (M3)", () => {
  it("the default region row exists with the canonical values", async () => {
    const h = getDbHarness();
    const repo = new PostgresRegionRepository(h.context);
    const region = await repo.findById("reg-storefront");
    expect(region).not.toBeNull();
    expect(region!.currencyCode).toBe("ngn");
    expect(region!.taxRate).toBe(750);
    expect(region!.paymentProviders).toEqual(["paystack"]);
    expect(region!.fulfillmentProviders).toEqual(["shipbubble"]);
  });

  it("the default sales channel row exists and is enabled", async () => {
    const h = getDbHarness();
    const repo = new PostgresSalesChannelRepository(h.context);
    const channel = await repo.findById("channel-storefront");
    expect(channel).not.toBeNull();
    expect(channel!.isDisabled).toBe(false);
  });

  it("the seeded rows are idempotent (re-running the seed SQL collides and is a no-op)", async () => {
    const h = getDbHarness();
    // Re-insert identical rows; UNIQUE/PK collision must not error and must not
    // create duplicates.
    await q(
      "INSERT INTO region (id, name, currency_code, tax_rate, payment_providers, fulfillment_providers) VALUES ('reg-storefront', 'Storefront', 'ngn', 750, '[\"paystack\"]', '[\"shipbubble\"]') ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    const count = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM region WHERE id = 'reg-storefront'
    `.execute(h.db);
    expect(count.rows[0].n).toBe("1");
  });
});

describe("Real Postgres — product category + media hydration (M1)", () => {
  it("the read path hydrates media references in deterministic order", async () => {
    const h = getDbHarness();

    await q(
      "INSERT INTO product (id, title, handle) VALUES ('f4-product', 'F4 Tee', 'f4-tee') ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    await q(
      "INSERT INTO category (id, name) VALUES ('f4-cat', 'F4 Category') ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    await q(
      "INSERT INTO product_category (product_id, category_id) VALUES ('f4-product', 'f4-cat') ON CONFLICT DO NOTHING",
    ).execute(h.db);
    await q(
      "INSERT INTO product_sales_channel (product_id, sales_channel_id) VALUES ('f4-product', 'channel-storefront') ON CONFLICT DO NOTHING",
    ).execute(h.db);
    await q(
      "INSERT INTO product_variant (id, product_id, sku, inventory_quantity, allow_backorder) VALUES ('f4-variant', 'f4-product', 'F4-SKU', 3, false) ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    await q(
      "INSERT INTO money_amount (id, variant_id, region_id, amount_minor) VALUES ('f4-ma', 'f4-variant', 'reg-storefront', 5000) ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    // Media rows deliberately inserted OUT of display order; hydration must sort.
    await q(
      "INSERT INTO product_media (id, product_id, url, kind, alt_text, sort_order) VALUES ('f4-m-2', 'f4-product', '/products/f4-2.jpg', 'image', 'second', 2) ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    await q(
      "INSERT INTO product_media (id, product_id, url, kind, alt_text, sort_order) VALUES ('f4-m-1', 'f4-product', '/products/f4-1.jpg', 'image', 'first', 1) ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);

    const repo = new PostgresProductReadRepository(h.context);
    const product = await repo.findByIdAndContext(
      "f4-product",
      "channel-storefront",
      "reg-storefront",
    );

    expect(product).not.toBeNull();
    expect(product!.categoryIds).toEqual(["f4-cat"]);
    expect(product!.media.length).toBe(2);
    const urls = product!.media.map((m) => m.url);
    expect(urls).toEqual(["/products/f4-1.jpg", "/products/f4-2.jpg"]);
    for (const media of product!.media) {
      expect(media).toBeInstanceOf(ProductMedia);
      expect(media.kind).toBe("image");
      expect(media.altText).not.toBeNull();
    }
  });

  it("a product with no media hydrates an empty array (safe default)", async () => {
    const h = getDbHarness();
    const repo = new PostgresProductReadRepository(h.context);
    await q(
      "INSERT INTO product (id, title, handle) VALUES ('f4-bare', 'Bare Tee', 'bare-tee') ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    await q(
      "INSERT INTO product_sales_channel (product_id, sales_channel_id) VALUES ('f4-bare', 'channel-storefront') ON CONFLICT DO NOTHING",
    ).execute(h.db);
    await q(
      "INSERT INTO product_variant (id, product_id, sku, inventory_quantity, allow_backorder) VALUES ('f4-bare-v', 'f4-bare', 'BARE-SKU', 1, false) ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    await q(
      "INSERT INTO money_amount (id, variant_id, region_id, amount_minor) VALUES ('f4-bare-ma', 'f4-bare-v', 'reg-storefront', 3000) ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);

    const product = await repo.findByIdAndContext(
      "f4-bare",
      "channel-storefront",
      "reg-storefront",
    );
    expect(product).not.toBeNull();
    expect(product!.media).toEqual([]);
  });
});