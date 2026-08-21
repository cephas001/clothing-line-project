// apps/storefront/tests/unit/homeSections.test.ts
//
// F9 / E1 — pure Home section derivation (src/lib/homeSections.ts).
// Sections come from the authoritative category tree in SERVER ORDER; products
// join a section through whole descendant groups; missing categories exclude
// products; empty categories stay visible as empty collections; nothing is
// ever claimed "sold out".

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import type { Category, Product } from "@clothing-line-project/shared-types";
import { makeCategory, makeProduct } from "../helpers/fixtures";
import { toProductViews } from "../../src/lib/product";
import {
  HOME_SECTION_PRODUCT_LIMIT,
  buildHomeSections,
  sectionContentState,
} from "../../src/lib/homeSections";

function viewsOf(products: Product[], categories: Category[]) {
  return toProductViews(products, categories);
}

describe("buildHomeSections — server authority", () => {
  it("follows SERVER order, not any hardcoded section order", () => {
    // Server lists jewelry BEFORE jackets — the reverse of the old hardcoded
    // SECTIONS array. The derivation must preserve payload order.
    const jewelry = makeCategory({ name: "Jewelry" });
    const jackets = makeCategory({ name: "Jackets" });
    const sections = buildHomeSections([jewelry, jackets], []);
    expect(sections.map((s) => s.label)).toEqual(["Jewelry", "Jackets"]);
    expect(sections.map((s) => s.index)).toEqual(["01", "02"]);
  });

  it("uses the server NAME and derived slug (renames flow through)", () => {
    const outerwear = makeCategory({ name: "Outerwear" });
    const [section] = buildHomeSections([outerwear], []);
    expect(section.label).toBe("Outerwear");
    expect(section.slug).toBe("outerwear");
    expect(section.href).toBe("/shop?category=outerwear");
  });

  it("keys sections by the server category id", () => {
    const category = makeCategory({ id: "cat-server-1", name: "Jackets" });
    const [section] = buildHomeSections([category], []);
    expect(section.key).toBe("cat-server-1");
  });

  it("treats a category with a MISSING parent as top-level (orphan)", () => {
    const orphan = makeCategory({
      name: "Off-Duties",
      parentCategoryId: "cat-gone",
    });
    const sections = buildHomeSections([orphan], []);
    expect(sections.length).toBe(1);
    expect(sections[0].label).toBe("Off-Duties");
  });

  it("renders CHILD categories inside their parent's group, not separately", () => {
    const parent = makeCategory({ name: "Apparel" });
    const child = makeCategory({
      name: "Scarves",
      parentCategoryId: parent.id,
    });
    const product = makeProduct({ categoryIds: [child.id] });
    const sections = buildHomeSections(
      [parent, child],
      viewsOf([product], [parent, child]),
    );
    expect(sections.length).toBe(1);
    expect(sections[0].items.length).toBe(1);
  });
});

describe("buildHomeSections — honest membership", () => {
  it("EXCLUDES products whose categories are missing from the tree", () => {
    const jackets = makeCategory({ name: "Jackets" });
    const stray = makeProduct({ categoryIds: ["cat-unknown"] });
    const known = makeProduct({ categoryIds: [jackets.id] });
    const sections = buildHomeSections(
      [jackets],
      viewsOf([stray, known], [jackets]),
    );
    expect(sections[0].items.length).toBe(1);
    // The excluded product is the stray one.
    expect(sections[0].items[0].categoryIds).toEqual([jackets.id]);
  });

  it("keeps an EMPTY category visible as a section with no items", () => {
    const jackets = makeCategory({ name: "Jackets" });
    const empty = makeCategory({ name: "Jewelry" });
    const product = makeProduct({ categoryIds: [jackets.id] });
    const sections = buildHomeSections(
      [jackets, empty],
      viewsOf([product], [jackets, empty]),
    );
    const jewelrySection = sections.find((s) => s.label === "Jewelry");
    expect(jewelrySection).toBeDefined();
    expect(jewelrySection?.items.length).toBe(0);
    expect(sectionContentState(jewelrySection?.items ?? [])).toBe(
      "empty-collection",
    );
  });

  it("caps each section at the presentation limit while preserving order", () => {
    const jackets = makeCategory({ name: "Jackets" });
    const products = Array.from({ length: 6 }, (_, i) =>
      makeProduct({
        title: `Jacket ${i + 1}`,
        handle: `jacket-${i + 1}`,
        categoryIds: [jackets.id],
      }),
    );
    const sections = buildHomeSections(
      [jackets],
      viewsOf(products, [jackets]),
    );
    expect(sections[0].items.length).toBe(HOME_SECTION_PRODUCT_LIMIT);
    expect(sections[0].items[0].name).toBe("Jacket 1");
    expect(sections[0].items[3].name).toBe("Jacket 4");
  });

  it("yields no sections from an empty tree (nothing invented)", () => {
    expect(buildHomeSections([], [])).toEqual([]);
  });
});

describe("sectionContentState — only truthful states exist", () => {
  it("populated when items exist; empty-collection otherwise", () => {
    const jackets = makeCategory({ name: "Jackets" });
    const views = viewsOf(
      [makeProduct({ categoryIds: [jackets.id] })],
      [jackets],
    );
    expect(sectionContentState(views)).toBe("populated");
    expect(sectionContentState([])).toBe("empty-collection");
  });
});
