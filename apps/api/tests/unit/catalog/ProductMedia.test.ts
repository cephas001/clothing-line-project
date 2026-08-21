// apps/api/tests/unit/catalog/ProductMedia.test.ts
//
// F4 PRE-IMPLEMENTATION (M1) — DOMAIN INVARIANTS FOR PRODUCT MEDIA.
//
// ProductMedia is a pure value object: it validates its invariants and is
// attached to Product via assignMedia. This suite pins:
//   - construction validation (empty id/url, non-integer/negative sortOrder);
//   - defaults (kind "image", altText null, sortOrder 0);
//   - Product.media returns a defensive, deterministically ordered copy
//     (sortOrder asc, then id for stable ties) — the ordering contract the
//     HTTP projection and cache serialization both rely on.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { ProductMedia } from "@api/domain/entities/ProductMedia";
import { Product } from "@api/domain/entities/Product";

describe("ProductMedia — construction invariants", () => {
  it("rejects empty id", () => {
    expect(() => new ProductMedia({ id: "", url: "/x.jpg" })).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("rejects empty url", () => {
    expect(() => new ProductMedia({ id: "m-1", url: "  " })).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("rejects non-integer sortOrder", () => {
    expect(
      () =>
        new ProductMedia({
          id: "m-1",
          url: "/x.jpg",
          sortOrder: 1.5,
        }),
    ).toThrowWithCode("VALIDATION_ERROR");
  });

  it("rejects negative sortOrder", () => {
    expect(
      () =>
        new ProductMedia({
          id: "m-1",
          url: "/x.jpg",
          sortOrder: -1,
        }),
    ).toThrowWithCode("VALIDATION_ERROR");
  });

  it("applies defaults: kind image, altText null, sortOrder 0", () => {
    const media = new ProductMedia({ id: "m-1", url: "/x.jpg" });
    expect(media.kind).toBe("image");
    expect(media.altText).toBeNull();
    expect(media.sortOrder).toBe(0);
  });
});

describe("Product.media — deterministic ordering and safe copy", () => {
  function makeProduct(media: ProductMedia[]): Product {
    return new Product({
      id: "p-1",
      title: "Tee",
      handle: "tee",
      media,
    });
  }

  it("orders by sortOrder ascending (lowest first)", () => {
    const product = makeProduct([
      new ProductMedia({ id: "m-b", url: "/b.jpg", sortOrder: 2 }),
      new ProductMedia({ id: "m-a", url: "/a.jpg", sortOrder: 1 }),
      new ProductMedia({ id: "m-c", url: "/c.jpg", sortOrder: 0 }),
    ]);
    expect(product.media.map((m) => m.url)).toEqual([
      "/c.jpg",
      "/a.jpg",
      "/b.jpg",
    ]);
  });

  it("breaks sortOrder ties by id for a stable order", () => {
    const product = makeProduct([
      new ProductMedia({ id: "z", url: "/z.jpg", sortOrder: 0 }),
      new ProductMedia({ id: "a", url: "/a.jpg", sortOrder: 0 }),
    ]);
    expect(product.media.map((m) => m.id)).toEqual(["a", "z"]);
  });

  it("returns a defensive copy (mutating the array cannot touch the entity)", () => {
    const product = makeProduct([
      new ProductMedia({ id: "m-1", url: "/a.jpg", sortOrder: 0 }),
    ]);
    const first = product.media;
    first.length = 0;
    expect(product.media).toHaveLength(1);
  });

  it("defaults to an empty array when no media is assigned", () => {
    const product = new Product({ id: "p-1", title: "Tee", handle: "tee" });
    expect(product.media).toEqual([]);
  });
});