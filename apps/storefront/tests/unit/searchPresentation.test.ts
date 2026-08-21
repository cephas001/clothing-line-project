// apps/storefront/tests/unit/searchPresentation.test.ts
//
// F7 Part 4 — honest search presentation rules (G013 + G031). Pure functions
// from src/lib/search.ts: the UI must never imply a full-store search (only
// the loaded catalogue page is filtered) and must report the exact count.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  emptyResultsMessage,
  searchResultsLine,
} from "../../src/lib/search";

describe("searchResultsLine (G013 — honest scope + exact count)", () => {
  it("names the loaded catalogue as the scope", () => {
    expect(searchResultsLine("jacket", 3)).toBe(
      "3 matches for \u201Cjacket\u201D in the loaded catalogue",
    );
  });

  it("uses singular for exactly one match", () => {
    expect(searchResultsLine("jacket", 1)).toBe(
      "1 match for \u201Cjacket\u201D in the loaded catalogue",
    );
  });

  it("reports zero honestly (never hides an empty result)", () => {
    expect(searchResultsLine("ghost", 0)).toContain("0 matches");
  });

  it("clamps negative and non-finite counts to zero (defensive)", () => {
    expect(searchResultsLine("x", -5)).toContain("0 matches");
    expect(searchResultsLine("x", Number.NaN)).toContain("0 matches");
    expect(searchResultsLine("x", Number.POSITIVE_INFINITY)).toContain(
      "0 matches",
    );
  });

  it("truncates fractional counts to integers", () => {
    expect(searchResultsLine("x", 2.9)).toContain("2 matches");
  });
});

describe("emptyResultsMessage (G031 — honest emptiness)", () => {
  it("distinguishes a category-scoped empty result from a failed search", () => {
    expect(
      emptyResultsMessage({ query: "wool", categoryName: "Jackets" }),
    ).toBe(
      "No matches for \u201Cwool\u201D in JACKETS within the loaded catalogue.",
    );
  });

  it("says an empty CATEGORY has no products (not that the search failed)", () => {
    expect(emptyResultsMessage({ query: "", categoryName: "Jewelry" })).toBe(
      "No products in JEWELRY within the loaded catalogue.",
    );
  });

  it("falls back to the unscoped message without a category", () => {
    expect(emptyResultsMessage({ query: "ghost" })).toBe(
      "No matches for \u201Cghost\u201D in the loaded catalogue.",
    );
  });

  it("treats whitespace-only query/category as absent", () => {
    expect(
      emptyResultsMessage({ query: "   ", categoryName: "   " }),
    ).toBe("No matches for \u201C\u201D in the loaded catalogue.");
  });

  it("handles undefined options defensively", () => {
    expect(emptyResultsMessage({})).toBe(
      "No matches for \u201C\u201D in the loaded catalogue.",
    );
  });
});
