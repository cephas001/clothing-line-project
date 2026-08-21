// apps/storefront/tests/unit/catalogProjections.test.ts
//
// Catalog projection rules (src/lib/product.ts). These are PURE functions: the
// server Product/Category DTOs are reduced to UI views. The invariant tested
// here: `priceMinor` is ALWAYS the authoritative server value (never invented,
// derived, or substituted), availability is a projection of the server's
// inventory fields, and slugs/categories come from the server payload.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  byCategory,
  categoryNameOf,
  categorySlugOf,
  findBySlug,
  mediaFromMedia,
  relatedProducts,
  toProductView,
  toProductViews,
  toVariantView,
} from "../../src/lib/product";
import { makeCategory, makeMedia, makeProduct, makeVariant } from "../helpers/fixtures";

describe("categorySlugOf", () => {
  it("lowercases and slugs a category name", () => {
    expect(categorySlugOf("Jackets")).toBe("jackets");
    expect(categorySlugOf("Off-Duties")).toBe("off-duties");
    expect(categorySlugOf("New Arrivals")).toBe("new-arrivals");
  });

  it("falls back to `all` for empty names", () => {
    expect(categorySlugOf("")).toBe("all");
    expect(categorySlugOf("   ")).toBe("all");
  });
});

describe("mediaFromMedia (F7.1 / G034 — N-slot gallery)", () => {
  it("maps ordered media to url + server altText", () => {
    const product = makeProduct({
      media: [
        makeMedia("/images/a.jpg", 0),
        makeMedia("/images/b.jpg", 1),
      ],
    });
    // makeMedia leaves altText null -> positional fallback is used.
    const media = mediaFromMedia(product.media, product.title);
    expect(media).toHaveLength(2);
    expect(media[0].url).toBe("/images/a.jpg");
    expect(media[1].url).toBe("/images/b.jpg");
  });

  it("renders zero entries without media (no fake slots)", () => {
    expect(mediaFromMedia([])).toEqual([]);
    expect(mediaFromMedia(undefined)).toEqual([]);
  });

  it("renders a single entry gracefully", () => {
    const media = mediaFromMedia([makeMedia("/images/only.jpg", 0)], "Test Jacket");
    expect(media).toHaveLength(1);
    expect(media[0].alt).toBe("Test Jacket — image 1");
  });

  it("uses the server altText when meaningful and falls back positionally otherwise", () => {
    const media = mediaFromMedia(
      [
        { ...makeMedia("/images/a.jpg", 0), altText: "Front view" },
        { ...makeMedia("/images/b.jpg", 1), altText: "   " },
        makeMedia("/images/c.jpg", 2),
      ],
      "Test Jacket",
    );
    expect(media[0].alt).toBe("Front view");
    expect(media[1].alt).toBe("Test Jacket — image 2");
    expect(media[2].alt).toBe("Test Jacket — image 3");
  });

  it("projects toProductView with an N-slot gallery and meaningful alts", () => {
    const view = toProductView(makeProduct());
    expect(view.media).toHaveLength(2);
    expect(view.media.every((item) => item.alt.trim() !== "")).toBe(true);
  });
});

describe("toVariantView", () => {
  it("passes the server priceMinor through untouched", () => {
    const view = toVariantView(makeVariant({ priceMinor: 25000 }));
    expect(view.priceMinor).toBe(25000);
  });

  it("passes null priceMinor through when the region has no price", () => {
    const view = toVariantView(makeVariant({ priceMinor: null }));
    expect(view.priceMinor).toBeNull();
  });

  it("is available when inventory > 0", () => {
    const view = toVariantView(makeVariant({ inventoryQuantity: 3, allowBackorder: false }));
    expect(view.available).toBe(true);
  });

  it("is available on backorder even at zero stock", () => {
    const view = toVariantView(makeVariant({ inventoryQuantity: 0, allowBackorder: true }));
    expect(view.available).toBe(true);
  });

  it("is unavailable at zero stock without backorder", () => {
    const view = toVariantView(makeVariant({ inventoryQuantity: 0, allowBackorder: false }));
    expect(view.available).toBe(false);
  });
});

describe("toProductView", () => {
  it("uses the first available variant's authoritative priceMinor", () => {
    const product = makeProduct({
      variants: [
        makeVariant({ priceMinor: 10000, inventoryQuantity: 0 }),
        makeVariant({ priceMinor: 12500, inventoryQuantity: 4 }),
      ],
    });
    const view = toProductView(product, "Jackets");
    expect(view.priceMinor).toBe(12500);
    expect(view.category).toBe("jackets");
    expect(view.slug).toBe(product.handle);
  });

  it("falls back to the first variant when none is available", () => {
    const product = makeProduct({
      variants: [makeVariant({ priceMinor: 9000, inventoryQuantity: 0 })],
    });
    const view = toProductView(product);
    expect(view.priceMinor).toBe(9000);
    expect(view.isSoldOut).toBe(true);
  });

  it("is sold out with no variants and priceMinor null", () => {
    const view = toProductView(makeProduct({ variants: [] }));
    expect(view.isSoldOut).toBe(true);
    expect(view.priceMinor).toBeNull();
  });

  it("marks sellingFast only for low positive stock (1..8)", () => {
    const low = toProductView(makeProduct({ variants: [makeVariant({ inventoryQuantity: 8 })] }));
    expect(low.sellingFast).toBe(true);

    const none = toProductView(
      makeProduct({ variants: [makeVariant({ inventoryQuantity: 0 })] }),
    );
    expect(none.sellingFast).toBe(false);

    const plenty = toProductView(
      makeProduct({ variants: [makeVariant({ inventoryQuantity: 9 })] }),
    );
    expect(plenty.sellingFast).toBe(false);
  });
});

describe("categoryNameOf", () => {
  it("resolves the first category id through the tree", () => {
    const category = makeCategory({ name: "Jewelry" });
    const product = makeProduct({ categoryIds: [category.id] });
    expect(categoryNameOf(product, [category])).toBe("Jewelry");
  });

  it("returns empty when there are no category ids", () => {
    expect(categoryNameOf(makeProduct({ categoryIds: [] }), [makeCategory()])).toBe("");
  });
});

describe("catalog list helpers", () => {
  const jackets = makeProduct({ handle: "jacket-a", categoryIds: ["c1"] });
  const jacketB = makeProduct({ handle: "jacket-b", categoryIds: ["c1"] });
  const ring = makeProduct({ handle: "ring", categoryIds: ["c2"] });
  const categories = [
    makeCategory({ id: "c1", name: "Jackets" }),
    makeCategory({ id: "c2", name: "Jewelry" }),
  ];
  const views = toProductViews([jackets, jacketB, ring], categories);

  it("toProductViews projects every product and resolves categories", () => {
    expect(views).toHaveLength(3);
    expect(views[0].category).toBe("jackets");
    expect(views[2].category).toBe("jewelry");
  });

  it("findBySlug locates a product by its slug", () => {
    expect(findBySlug(views, "jacket-b")?.id).toBe(jacketB.id);
    expect(findBySlug(views, "missing")).toBeUndefined();
  });

  it("byCategory filters by the projected category slug", () => {
    expect(byCategory(views, "jackets")).toHaveLength(2);
    expect(byCategory(views, "jewelry")).toHaveLength(1);
  });

  it("relatedProducts returns same-category items excluding the product itself, respecting the limit", () => {
    const jacketAView = findBySlug(views, "jacket-a")!;
    const related = relatedProducts(views, jacketAView, 1);
    expect(related).toHaveLength(1);
    expect(related[0].id).toBe(jacketB.id);
    expect(related.some((view) => view.id === jacketAView.id)).toBe(false);
  });
});