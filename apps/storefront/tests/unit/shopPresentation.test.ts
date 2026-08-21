// apps/storefront/tests/unit/shopPresentation.test.ts
//
// F9 / E2 + F8-S1 — pure Shop presentation rules (src/lib/shopPresentation.ts).
// Tabs derive from the server tree in payload order; filtering scopes by whole
// descendant groups; truncation is stated, never hidden; a failed tree is
// never rendered as success and retries are rate-limited.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import type { Category, Product } from "@clothing-line-project/shared-types";
import { makeCategory, makeProduct } from "../helpers/fixtures";
import { toProductViews } from "../../src/lib/product";
import {
  MIN_TREE_RETRY_INTERVAL_MS,
  buildShopTabs,
  filterShopProducts,
  pdpTruncationNotice,
  resolveShopTreeState,
  shopHeading,
  shopTreeFailureNotice,
  shouldAllowRetry,
  truncatedCatalogLine,
} from "../../src/lib/shopPresentation";

function viewsOf(products: Product[], categories: Category[]) {
  return toProductViews(products, categories);
}

describe("buildShopTabs — server authority", () => {
  it("lists ALL first, then top-level categories in SERVER order", () => {
    const tabs = buildShopTabs(
      [
        { id: "c1", name: "Jewelry", slug: "jewelry" },
        { id: "c2", name: "Jackets", slug: "jackets" },
      ],
      "all",
    );
    expect(tabs.map((t) => t.key)).toEqual(["all", "jewelry", "jackets"]);
    expect(tabs[0].label).toBe("ALL");
  });

  it("keeps an unknown ?category= slug visible (never silently resets)", () => {
    const tabs = buildShopTabs(
      [{ id: "c1", name: "Jewelry", slug: "jewelry" }],
      "ghost-slug",
    );
    expect(tabs.map((t) => t.key)).toEqual(["all", "ghost-slug", "jewelry"]);
    expect(tabs[1].label).toBe("GHOST-SLUG");
  });

  it("renders only ALL for an honestly empty tree", () => {
    expect(buildShopTabs([], "all")).toEqual([{ key: "all", label: "ALL" }]);
  });
});

describe("resolveShopTreeState — honest usability", () => {
  it("maps loading → loading (scoping undecided yet)", () => {
    expect(resolveShopTreeState("loading")).toBe("loading");
  });

  it("maps error → failed (failure stays visible)", () => {
    expect(resolveShopTreeState("error")).toBe("failed");
  });

  it("maps success AND empty → ready (an empty tree is usable truth)", () => {
    expect(resolveShopTreeState("success")).toBe("ready");
    expect(resolveShopTreeState("empty")).toBe("ready");
  });
});

describe("filterShopProducts — scoping rules", () => {
  const catalog = viewsOf(
    [
      makeProduct({ title: "Wool Jacket", categoryIds: ["cat-jackets"] }),
      makeProduct({ title: "Gold Ring", categoryIds: ["cat-jewelry"] }),
      makeProduct({ title: "Ring Buffer", categoryIds: [] }),
    ],
    [],
  );

  it("a null group means no category scoping (query still applies)", () => {
    const out = filterShopProducts(catalog, { groupIds: null, query: "" });
    expect(out).toHaveLength(3);
  });

  it("scopes by ANY membership in the descendant group", () => {
    const out = filterShopProducts(catalog, {
      groupIds: new Set(["cat-jewelry"]),
      query: "",
    });
    expect(out.map((p) => p.name)).toEqual(["Gold Ring"]);
  });

  it("matches the name query case-insensitively on the LOADED page", () => {
    const out = filterShopProducts(catalog, {
      groupIds: null,
      query: "RING",
    });
    expect(out.map((p) => p.name)).toEqual(["Gold Ring", "Ring Buffer"]);
  });

  it("combines group and query scope with AND semantics", () => {
    const out = filterShopProducts(catalog, {
      groupIds: new Set(["cat-jewelry"]),
      query: "ring",
    });
    expect(out.map((p) => p.name)).toEqual(["Gold Ring"]);
  });
});

describe("truncatedCatalogLine — truncation honesty", () => {
  it("returns null when the page IS the complete result set", () => {
    expect(truncatedCatalogLine(200, 200)).toBeNull();
    expect(truncatedCatalogLine(5, 5)).toBeNull();
    expect(truncatedCatalogLine(3, 2)).toBeNull();
  });

  it("states exactly what is shown when the server total exceeds the page", () => {
    const line = truncatedCatalogLine(200, 350);
    expect(line).not.toBeNull();
    if (line !== null) {
      expect(line.includes("200")).toBe(true);
      expect(line.includes("350")).toBe(true);
      expect(line.toLowerCase().includes("matching products")).toBe(true);
    }
  });

  it("returns null for unusable inputs instead of inventing numbers", () => {
    expect(truncatedCatalogLine(Number.NaN, 10)).toBeNull();
    expect(truncatedCatalogLine(10, Number.NaN)).toBeNull();
  });
});

describe("shopTreeFailureNotice — failure is never silent", () => {
  it("announces the degradation without pretending success", () => {
    const notice = shopTreeFailureNotice(false);
    expect(notice.toLowerCase().includes("temporarily unavailable")).toBe(true);
    expect(notice.toLowerCase().includes("loaded catalogue")).toBe(true);
  });

  it("names the paused collection filtering when a slug was requested", () => {
    const notice = shopTreeFailureNotice(true);
    expect(notice).not.toBe(shopTreeFailureNotice(false));
    expect(notice.toLowerCase().includes("collection filtering")).toBe(true);
  });
});

describe("shouldAllowRetry — rapid-click protection", () => {
  it("allows the first attempt (no prior attempt recorded)", () => {
    expect(shouldAllowRetry(null, 1000)).toBe(true);
  });

  it("blocks clicks inside the minimum interval", () => {
    expect(
      shouldAllowRetry(1000, 1000 + MIN_TREE_RETRY_INTERVAL_MS - 1),
    ).toBe(false);
  });

  it("allows clicks at or after the interval", () => {
    expect(
      shouldAllowRetry(1000, 1000 + MIN_TREE_RETRY_INTERVAL_MS),
    ).toBe(true);
    expect(
      shouldAllowRetry(1000, 1000 + MIN_TREE_RETRY_INTERVAL_MS * 5),
    ).toBe(true);
  });

  it("rejects unusable clock readings instead of allowing a storm", () => {
    expect(shouldAllowRetry(1000, Number.NaN)).toBe(false);
  });
});

describe("pdpTruncationNotice — PDP truncation honesty (F10)", () => {
  it("states the limit when the hook reports a truncated browse list", () => {
    const notice = pdpTruncationNotice({
      catalogTruncated: true,
      shownCount: 200,
      totalCount: 350,
    });
    expect(notice).toBe(truncatedCatalogLine(200, 350));
    expect(notice?.includes("200")).toBe(true);
    expect(notice?.includes("350")).toBe(true);
  });

  it("renders nothing for a complete catalogue", () => {
    expect(
      pdpTruncationNotice({
        catalogTruncated: false,
        shownCount: 120,
        totalCount: 120,
      }),
    ).toBeNull();
  });

  it("the boolean gates the notice — inconsistent counts never fake one", () => {
    expect(
      pdpTruncationNotice({
        catalogTruncated: false,
        shownCount: 10,
        totalCount: 999,
      }),
    ).toBeNull();
  });

  it("a truncated flag with consistent counts still refuses to warn", () => {
    expect(
      pdpTruncationNotice({
        catalogTruncated: true,
        shownCount: 350,
        totalCount: 350,
      }),
    ).toBeNull();
  });
});

describe("shopHeading — server-derived heading context (F10)", () => {
  it("ALL selected keeps SHOP ALL", () => {
    expect(shopHeading(null)).toBe("SHOP ALL");
  });

  it("a KNOWN server category uses its actual display name", () => {
    expect(shopHeading("Jackets")).toBe("JACKETS");
    expect(shopHeading("Fine Jewelry")).toBe("FINE JEWELRY");
  });

  it("an UNKNOWN ?category= slug falls back honestly — never invents a name", () => {
    // The view resolves knownCategory=null for unknown slugs.
    expect(shopHeading(null)).toBe("SHOP ALL");
  });

  it("loading/failure/empty tree also fall back (no category is resolvable)", () => {
    // While the tree loads or failed, the view passes null — no fabricated
    // heading from a slug or stale state.
    expect(shopHeading("")).toBe("SHOP ALL");
    expect(shopHeading("   ")).toBe("SHOP ALL");
  });

  it("uppercases whatever name it receives — slug protection lives at the call site", () => {
    // shopHeading cannot distinguish slugs from names; the guarantee is that
    // ShopView only passes knownCategory?.name (a SERVER display name) or
    // null — never params.get("category") — so unknown slugs stay SHOP ALL.
    expect(shopHeading("ghost-slug")).toBe("GHOST-SLUG");
  });
});
