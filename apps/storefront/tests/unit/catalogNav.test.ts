// apps/storefront/tests/unit/catalogNav.test.ts
//
// F7 Part 3 — server-derived navigation (G012), honest display currency
// (G032), and the categoryIds projection that powers group filtering.
// All pure functions: no network, no storage.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  categoryGroupIds,
  navCategories,
  toProductView,
} from "../../src/lib/product";
import { displayCurrencyOf } from "../../src/lib/cart";
import { makeCategory, makeProduct, makeVariant } from "../helpers/fixtures";

describe("navCategories (F7 / G012 — server-derived navigation)", () => {
  it("returns no entries for an empty tree (honest empty state)", () => {
    expect(navCategories([])).toEqual([]);
  });

  it("derives top-level entries with slugs, in payload order", () => {
    const categories = [
      makeCategory({ id: "c1", name: "Jackets" }),
      makeCategory({ id: "c2", name: "Off-Duties" }),
    ];
    expect(navCategories(categories)).toEqual([
      { id: "c1", name: "Jackets", slug: "jackets" },
      { id: "c2", name: "Off-Duties", slug: "off-duties" },
    ]);
  });

  it("excludes child categories from top-level navigation", () => {
    const categories = [
      makeCategory({ id: "p1", name: "Accessories", parentCategoryId: null }),
      makeCategory({
        id: "ch1",
        name: "Belts",
        parentCategoryId: "p1",
      }),
    ];
    const nav = navCategories(categories);
    expect(nav).toHaveLength(1);
    expect(nav[0].name).toBe("Accessories");
  });

  it("treats a category whose parent is missing from the payload as top-level", () => {
    // Partial tree fallback: the honest option is to show the entry rather
    // than silently drop reachable categories.
    const categories = [
      makeCategory({ id: "orphan", name: "Jewelry", parentCategoryId: "ghost" }),
    ];
    expect(navCategories(categories)).toHaveLength(1);
    expect(navCategories(categories)[0].slug).toBe("jewelry");
  });
});

describe("categoryGroupIds (G012 — descendant-group filtering)", () => {
  const tree = [
    makeCategory({ id: "root", name: "Clothing", parentCategoryId: null }),
    makeCategory({ id: "mid", name: "Outerwear", parentCategoryId: "root" }),
    makeCategory({ id: "leaf", name: "Jackets", parentCategoryId: "mid" }),
    makeCategory({ id: "other", name: "Jewelry", parentCategoryId: null }),
  ];

  it("includes the category itself and all descendants", () => {
    const ids = categoryGroupIds("root", tree);
    expect(ids.has("root")).toBe(true);
    expect(ids.has("mid")).toBe(true);
    expect(ids.has("leaf")).toBe(true);
    expect(ids.has("other")).toBe(false);
  });

  it("resolves multi-level chains from any starting node", () => {
    const ids = categoryGroupIds("mid", tree);
    expect(ids.has("mid")).toBe(true);
    expect(ids.has("leaf")).toBe(true);
    expect(ids.has("root")).toBe(false);
  });

  it("is cycle-safe", () => {
    const cyclic = [
      makeCategory({ id: "a", name: "A", parentCategoryId: "b" }),
      makeCategory({ id: "b", name: "B", parentCategoryId: "a" }),
    ];
    expect(categoryGroupIds("a", cyclic)).toEqual(new Set(["a", "b"]));
  });

  it("returns just the id for an unknown category", () => {
    expect(categoryGroupIds("nope", tree)).toEqual(new Set(["nope"]));
  });
});

describe("toProductView categoryIds projection (G012)", () => {
  it("projects ALL server-assigned category ids for group matching", () => {
    const product = makeProduct({
      categoryIds: ["root", "mid"],
      variants: [makeVariant()],
    });
    expect(toProductView(product).categoryIds).toEqual(["root", "mid"]);
  });

  it("defaults to an empty list when the server omits categoryIds", () => {
    const product = makeProduct({ variants: [makeVariant()] });
    delete (product as { categoryIds?: string[] }).categoryIds;
    expect(toProductView(product).categoryIds).toEqual([]);
  });
});

describe("displayCurrencyOf (F7 / G032 — authoritative cart currency)", () => {
  it("uses the server cart's currency code when present", () => {
    expect(displayCurrencyOf({ currency: "USD" }, "NGN")).toBe("USD");
  });

  it("falls back while no cart projection exists yet", () => {
    expect(displayCurrencyOf(null, "NGN")).toBe("NGN");
    expect(displayCurrencyOf(undefined, "NGN")).toBe("NGN");
  });

  it("falls back on a blank currency code (defensive)", () => {
    expect(displayCurrencyOf({ currency: "" }, "NGN")).toBe("NGN");
    expect(displayCurrencyOf({ currency: "   " }, "NGN")).toBe("NGN");
  });
});
