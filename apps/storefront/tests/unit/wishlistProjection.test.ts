// apps/storefront/tests/unit/wishlistProjection.test.ts
//
// F9 / E5 + F8-W1 — pure wishlist projection (src/lib/wishlistProjection.ts).
// Saved ids, resolved products and missing ids stay DISTINCT: a saved id is
// never silently dropped, and absence from a TRUNCATED catalogue page is
// reported as "unresolved", not as "unavailable".

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { makeProduct } from "../helpers/fixtures";
import { toProductViews } from "../../src/lib/product";
import {
  missingWishlistNotice,
  presentMissingWishlistItem,
  projectWishlist,
  wishlistContentState,
} from "../../src/lib/wishlistProjection";

function catalogOf(idsAndTitles: Array<[string, string]>) {
  return toProductViews(
    idsAndTitles.map(([id, title]) => makeProduct({ id, title })),
    [],
  );
}

describe("projectWishlist — saved order and deduplication", () => {
  it("resolves in SAVED order, not catalogue order", () => {
    const catalog = catalogOf([
      ["prod-a", "Alpha"],
      ["prod-b", "Beta"],
    ]);
    const projection = projectWishlist({
      savedIds: ["prod-b", "prod-a"],
      catalog,
      catalogComplete: true,
    });
    expect(projection.resolved.map((p) => p.id)).toEqual([
      "prod-b",
      "prod-a",
    ]);
    expect(projection.missing).toEqual([]);
  });

  it("collapses duplicate saves to their first occurrence", () => {
    const catalog = catalogOf([["prod-a", "Alpha"]]);
    const projection = projectWishlist({
      savedIds: ["prod-a", "prod-a"],
      catalog,
      catalogComplete: true,
    });
    expect(projection.savedIds).toEqual(["prod-a"]);
    expect(projection.resolved).toHaveLength(1);
  });

  it("drops blank ids defensively (storage is untrusted)", () => {
    const projection = projectWishlist({
      savedIds: ["", "   ", "prod-a"],
      catalog: catalogOf([["prod-a", "Alpha"]]),
      catalogComplete: true,
    });
    expect(projection.savedIds).toEqual(["prod-a"]);
  });
});

describe("projectWishlist — missing-id honesty", () => {
  it("a complete catalogue makes absence authoritative → 'unavailable'", () => {
    const projection = projectWishlist({
      savedIds: ["prod-gone"],
      catalog: catalogOf([["prod-a", "Alpha"]]),
      catalogComplete: true,
    });
    expect(projection.resolved).toEqual([]);
    expect(projection.missing).toEqual([
      { id: "prod-gone", reason: "unavailable" },
    ]);
  });

  it("a truncated catalogue page makes absence inconclusive → 'unresolved'", () => {
    const projection = projectWishlist({
      savedIds: ["prod-beyond-page-200"],
      catalog: catalogOf([["prod-a", "Alpha"]]),
      catalogComplete: false,
    });
    expect(projection.missing).toEqual([
      { id: "prod-beyond-page-200", reason: "unresolved" },
    ]);
  });

  it("keeps resolved and missing side by side in a partial wishlist", () => {
    const projection = projectWishlist({
      savedIds: ["prod-a", "prod-gone", "prod-b"],
      catalog: catalogOf([
        ["prod-a", "Alpha"],
        ["prod-b", "Beta"],
      ]),
      catalogComplete: true,
    });
    expect(projection.savedIds).toHaveLength(3);
    expect(projection.resolved.map((p) => p.id)).toEqual(["prod-a", "prod-b"]);
    expect(projection.missing.map((m) => m.id)).toEqual(["prod-gone"]);
  });
});

describe("wishlistContentState — truthful content states", () => {
  it("'empty' when nothing was ever saved", () => {
    const state = wishlistContentState(
      projectWishlist({ savedIds: [], catalog: [], catalogComplete: true }),
    );
    expect(state).toBe("empty");
  });

  it("'populated' when every save resolved", () => {
    const state = wishlistContentState(
      projectWishlist({
        savedIds: ["prod-a"],
        catalog: catalogOf([["prod-a", "Alpha"]]),
        catalogComplete: true,
      }),
    );
    expect(state).toBe("populated");
  });

  it("'partially-available' when some saves are missing", () => {
    const state = wishlistContentState(
      projectWishlist({
        savedIds: ["prod-a", "prod-gone"],
        catalog: catalogOf([["prod-a", "Alpha"]]),
        catalogComplete: true,
      }),
    );
    expect(state).toBe("partially-available");
  });

  it("'none-available' when every save is missing — NOT 'empty'", () => {
    const state = wishlistContentState(
      projectWishlist({
        savedIds: ["prod-gone"],
        catalog: [],
        catalogComplete: true,
      }),
    );
    expect(state).toBe("none-available");
  });
});

describe("missingWishlistNotice — explicit unavailability copy", () => {
  it("returns null when nothing is missing", () => {
    expect(missingWishlistNotice(0, "unavailable")).toBeNull();
    expect(missingWishlistNotice(-1, "unresolved")).toBeNull();
  });

  it("distinguishes unavailable from unresolved wording", () => {
    const unavailable = missingWishlistNotice(1, "unavailable");
    const unresolved = missingWishlistNotice(1, "unresolved");
    expect(unavailable).not.toBeNull();
    expect(unresolved).not.toBeNull();
    if (unavailable !== null && unresolved !== null) {
      expect(unavailable).not.toBe(unresolved);
      expect(unavailable.toLowerCase()).toContain("no longer exist");
      expect(unresolved.toLowerCase()).toContain("could not be loaded");
      expect(unresolved.toLowerCase()).toContain("incomplete");
    }
  });

  it("pluralizes correctly", () => {
    const notice = missingWishlistNotice(3, "unavailable");
    expect(notice).not.toBeNull();
    if (notice !== null) {
      expect(notice.startsWith("3 saved items")).toBe(true);
    }
  });
});

describe("presentMissingWishlistItem — F10 presentation hierarchy", () => {
  it("hierarchy 1 — a known title leads and no REF line is shown", () => {
    const p = presentMissingWishlistItem({
      id: "prod-x",
      reason: "unavailable",
      title: "Wool Overcoat",
    });
    expect(p.heading).toBe("Wool Overcoat");
    expect(p.headingIsTitle).toBe(true);
    expect(p.statusLabel).toBe("NO LONGER AVAILABLE");
    expect(p.diagnosticId).toBeNull();
  });

  it("a known title keeps the unresolved status distinct", () => {
    const p = presentMissingWishlistItem({
      id: "prod-y",
      reason: "unresolved",
      title: "Silk Scarf",
    });
    expect(p.heading).toBe("Silk Scarf");
    expect(p.headingIsTitle).toBe(true);
    expect(p.statusLabel).toBe("NOT LOADED — CATALOGUE INCOMPLETE");
    expect(p.diagnosticId).toBeNull();
  });

  it("hierarchy 4 — without a title the id is a labelled diagnostic, not a name", () => {
    const p = presentMissingWishlistItem({ id: "abc123", reason: "unavailable" });
    expect(p.heading).toBe("SAVED ITEM");
    expect(p.headingIsTitle).toBe(false);
    expect(p.statusLabel).toBe("NO LONGER AVAILABLE");
    expect(p.diagnosticId).toBe("abc123");
  });

  it("the unresolved reason stays distinct for untitled items too", () => {
    const p = presentMissingWishlistItem({ id: "def456", reason: "unresolved" });
    expect(p.heading).toBe("SAVED ITEM");
    expect(p.statusLabel).toBe("NOT LOADED — CATALOGUE INCOMPLETE");
    expect(p.diagnosticId).toBe("def456");
  });

  it("a blank/whitespace title counts as unknown (never renders blank)", () => {
    const p = presentMissingWishlistItem({
      id: "ghi789",
      reason: "unavailable",
      title: "   ",
    });
    expect(p.headingIsTitle).toBe(false);
    expect(p.diagnosticId).toBe("ghi789");
  });

  it("a whitespace-padded known title is trimmed into the heading", () => {
    const p = presentMissingWishlistItem({
      id: "jkl012",
      reason: "unresolved",
      title: "  Cashmere Knit  ",
    });
    expect(p.heading).toBe("Cashmere Knit");
    expect(p.headingIsTitle).toBe(true);
  });

  it("an empty id degrades to an explicit unknown-reference marker", () => {
    const p = presentMissingWishlistItem({ id: "", reason: "unresolved" });
    expect(p.heading).toBe("SAVED ITEM");
    expect(p.diagnosticId).toBe("(unknown reference)");
  });
});
