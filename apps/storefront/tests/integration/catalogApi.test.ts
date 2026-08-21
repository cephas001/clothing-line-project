// apps/storefront/tests/integration/catalogApi.test.ts
//
// Catalog service layer over real HTTP: query-param construction, storefront-
// context headers, response parsing, and the shared per-session catalog cache
// (one fetch reused across home/shop/PDP/wishlist/cart).

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  clearCatalogCache,
  getCatalog,
  getProduct,
  getVariantAvailability,
  listCategories,
  listProducts,
} from "../../src/lib/api/catalog";
import { testServer } from "../helpers/testServer";
import { makeCategory, makeProduct, makeVariant } from "../helpers/fixtures";

describe("catalog service layer", () => {
  it("listProducts builds the pagination/filter query and parses the page", async () => {
    await testServer.listen();
    testServer.clearReceived();
    const product = makeProduct({ handle: "jacket" });
    testServer.when("GET", "/store/products", () => ({
      status: 200,
      body: { items: [product], total: 1 },
    }));
    const page = await listProducts({ limit: 20, offset: 40, searchQuery: "jacket", categoryId: "c1" });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.items[0].handle).toBe("jacket");
    const req = testServer.last();
    const query = new URLSearchParams(req?.query ?? "");
    expect(query.get("limit")).toBe("20");
    expect(query.get("offset")).toBe("40");
    expect(query.get("searchQuery")).toBe("jacket");
    expect(query.get("categoryId")).toBe("c1");
    expect(req?.headers["region_id"]).toBe("reg-test");
    expect(req?.headers["sales_channel_id"]).toBe("channel-test");
  });

  it("listCategories parses the flat category tree", async () => {
    await testServer.listen();
    testServer.clearReceived();
    const category = makeCategory({ name: "Jackets" });
    testServer.when("GET", "/store/product-categories", () => ({
      status: 200,
      body: [category],
    }));
    const categories = await listCategories();
    expect(categories).toHaveLength(1);
    expect(categories[0].name).toBe("Jackets");
  });

  it("getCatalog fetches products + categories once and reuses the cached payload", async () => {
    await testServer.listen();
    clearCatalogCache();
    testServer.clearReceived();
    const product = makeProduct({ handle: "jacket" });
    const category = makeCategory({ id: "c1", name: "Jackets" });
    testServer.when("GET", "/store/products", () => ({
      status: 200,
      body: { items: [product], total: 1 },
    }));
    testServer.when("GET", "/store/product-categories", () => ({
      status: 200,
      body: [category],
    }));

    const first = await getCatalog();
    expect(first.products).toHaveLength(1);
    expect(first.categories).toHaveLength(1);
    const requestsAfterFirst = testServer.received.length;

    const second = await getCatalog();
    expect(second.products).toHaveLength(1);
    // No additional network traffic for the cached call.
    expect(testServer.received.length).toBe(requestsAfterFirst);

    // Busting the cache forces a fresh fetch.
    clearCatalogCache();
    testServer.clearReceived();
    await getCatalog();
    expect(testServer.received.length).toBeGreaterThan(0);
  });

  it("getCatalog surfaces the server's total metadata (G019 truncation signal)", async () => {
    await testServer.listen();
    clearCatalogCache();
    testServer.clearReceived();
    testServer.when("GET", "/store/products", () => ({
      status: 200,
      body: { items: [makeProduct()], total: 250 },
    }));
    testServer.when("GET", "/store/product-categories", () => ({
      status: 200,
      body: [],
    }));
    const payload = await getCatalog();
    expect(payload.products).toHaveLength(1);
    expect(payload.total).toBe(250);
    expect(payload.total).toBeGreaterThan(payload.products.length);
  });

  it("getProduct fetches the dedicated detail endpoint with storefront context (G018)", async () => {
    await testServer.listen();
    testServer.clearReceived();
    const product = makeProduct({ id: "prod-detail-1", handle: "detail" });
    testServer.when("GET", "/store/products/prod-detail-1", () => ({
      status: 200,
      body: product,
    }));
    const detail = await getProduct("prod-detail-1");
    expect(detail.id).toBe("prod-detail-1");
    expect(detail.handle).toBe("detail");
    const req = testServer.last();
    expect(req?.headers["region_id"]).toBe("reg-test");
    expect(req?.headers["sales_channel_id"]).toBe("channel-test");
  });

  it("getVariantAvailability parses the live availability DTO (G017)", async () => {
    await testServer.listen();
    testServer.clearReceived();
    const variant = makeVariant({ id: "var-live-1", inventoryQuantity: 0, allowBackorder: true });
    testServer.when("GET", "/store/variants/var-live-1/availability", () => ({
      status: 200,
      body: {
        variantId: variant.id,
        inventoryQuantity: 0,
        allowBackorder: true,
        priceMinor: null,
      },
    }));
    const availability = await getVariantAvailability("var-live-1");
    expect(availability.variantId).toBe("var-live-1");
    expect(availability.inventoryQuantity).toBe(0);
    expect(availability.allowBackorder).toBe(true);
    expect(availability.priceMinor).toBeNull();
    const req = testServer.last();
    expect(req?.headers["region_id"]).toBe("reg-test");
  });
});