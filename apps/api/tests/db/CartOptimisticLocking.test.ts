// apps/api/tests/db/CartOptimisticLocking.test.ts
//
// REAL-POSTGRES CART OPTIMISTIC LOCK TEST — L6 item 26.
//
// Two independent aggregates hydrate from the same DB version, one writer
// saves (bumping `cart.version`), and the OTHER writer's save must be rejected
// with RepositoryErrorCode.LOCKED (mapped to `LOCK_ACQUISITION_FAILED` at the
// use-case boundary). This proves the repository's version-guarded UPDATE is
// the final concurrency guard, not just an in-memory convention.

import { sql } from "kysely";
import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { getDbHarness } from "./dbHarness";
import { Cart } from "@api-domain-entities/Cart";
import { CartLineItem } from "@api-domain-entities/CartLineItem";
import { RepositoryErrorCode } from "@api-domain-interfaces/shared/errors/RepositoryError";

async function seedCart(cartId: string): Promise<void> {
  const h = getDbHarness();
  await sql
    .raw(
      `INSERT INTO region (id, name, currency_code, tax_rate) VALUES ('region-lock', 'Test', 'NGN', 750) ON CONFLICT (id) DO NOTHING`,
    )
    .execute(h.db);
  await sql
    .raw(
      `INSERT INTO sales_channel (id, name) VALUES ('channel-lock', 'DB') ON CONFLICT (id) DO NOTHING`,
    )
    .execute(h.db);
  // cart_line_item.variant_id is an FK; seed the product chain once.
  await sql
    .raw(
      `INSERT INTO product (id, title, handle) VALUES ('product-lock', 'Lock item', 'lock-item') ON CONFLICT (id) DO NOTHING`,
    )
    .execute(h.db);
  await sql
    .raw(
      `INSERT INTO product_variant (id, product_id, sku, inventory_quantity, allow_backorder, version) VALUES ('variant-lock-a', 'product-lock', 'LK-A', 100, false, 0) ON CONFLICT (id) DO NOTHING`,
    )
    .execute(h.db);
  await sql
    .raw(
      `INSERT INTO product_variant (id, product_id, sku, inventory_quantity, allow_backorder, version) VALUES ('variant-lock-b', 'product-lock', 'LK-B', 100, false, 0) ON CONFLICT (id) DO NOTHING`,
    )
    .execute(h.db);
  await sql
    .raw(
      `INSERT INTO product_variant (id, product_id, sku, inventory_quantity, allow_backorder, version) VALUES ('variant-lock-c', 'product-lock', 'LK-C', 100, false, 0) ON CONFLICT (id) DO NOTHING`,
    )
    .execute(h.db);
  // Seed the row directly (version 0) so both aggregates load the SAME version.
  await sql
    .raw(
      `INSERT INTO cart (id, region_id, sales_channel_id) VALUES ('${cartId}', 'region-lock', 'channel-lock')`,
    )
    .execute(h.db);
}

function makeItem(cartId: string, variantId: string, quantity: number): CartLineItem {
  return new CartLineItem({
    id: `li-${variantId}`,
    cartId,
    variantId,
    quantity,
    unitPriceMinor: 61000,
    createdAt: new Date().toISOString(),
    title: "DB lock test item",
  });
}

describe("Real Postgres — cart optimistic locking (item 26)", () => {
  it("two readers at version 0; the first save wins, the stale save is LOCKED", async () => {
    const h = getDbHarness();
    const cartId = "cart-optlock-1";
    await seedCart(cartId);

    // Two INDEPENDENT aggregates both hydrated at the persisted version 0.
    const writerA = await h.cartRepository.findById(cartId);
    const writerB = await h.cartRepository.findById(cartId);
    expect(writerA).not.toBeNull();
    expect(writerB).not.toBeNull();
    if (!writerA || !writerB) {
      return;
    }
    expect(writerA.loadedVersion).toBe(0);
    expect(writerB.loadedVersion).toBe(0);

    // Writer A mutates and saves: version 0 -> 1 (UPDATE guarded by version 0).
    writerA.addOrUpdateItem(makeItem(cartId, "variant-lock-a", 1));
    expect(writerA.version).toBe(1);
    await h.cartRepository.save(writerA);

    // Writer B is now STALE (its loadedVersion is still 0; the row is at 1).
    writerB.addOrUpdateItem(makeItem(cartId, "variant-lock-b", 1));
    let rejected = false;
    let code: string | undefined;
    try {
      await h.cartRepository.save(writerB);
    } catch (err: unknown) {
      rejected = true;
      code = (err as { code?: string }).code;
    }
    expect(rejected).toBe(true);
    expect(code).toBe(RepositoryErrorCode.LOCKED);

    // The DB row reflects writer A's state (version 1), NOT writer B's.
    const row = await sql<{ version: number }>`
      SELECT version FROM cart WHERE id = 'cart-optlock-1'
    `.execute(h.db);
    expect(row.rows[0].version).toBe(1);

    const items = await sql<{ variant_id: string | null }>`
      SELECT variant_id FROM cart_line_item WHERE cart_id = 'cart-optlock-1'
    `.execute(h.db);
    expect(items.rows.length).toBe(1);
    expect(items.rows[0].variant_id).toBe("variant-lock-a");
  });

  it("after a successful save the aggregate's loadedVersion advances to the saved version", async () => {
    const h = getDbHarness();
    const cartId = "cart-optlock-2";
    await seedCart(cartId);

    const cart = await h.cartRepository.findById(cartId);
    expect(cart).not.toBeNull();
    if (!cart) {
      return;
    }
    expect(cart.loadedVersion).toBe(0);

    cart.addOrUpdateItem(makeItem(cartId, "variant-lock-c", 2));
    await h.cartRepository.save(cart);
    expect(cart.loadedVersion).toBe(1);

    // A second mutation + save must succeed because loadedVersion tracks the
    // now-persisted version (no false LOCKED for sequential saves).
    cart.addOrUpdateItem(makeItem(cartId, "variant-lock-c", 3));
    await h.cartRepository.save(cart);
    expect(cart.loadedVersion).toBe(2);
  });
});