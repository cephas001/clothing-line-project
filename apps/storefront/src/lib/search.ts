// apps/storefront/src/lib/search.ts
//
// F7 Part 3 / G013+G031 — honest search presentation rules.
//
// Client-side search filters ONLY the loaded catalogue page (the browse list,
// capped by the server's own limit). These pure functions render that scope
// honestly: they never imply a full-store search and always report the real
// match count. No financial or pricing data flows through here.

/** Defensive clamp: a match count is a non-negative integer, always. */
function clampCount(count: number): number {
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.trunc(count));
}

/**
 * The live results line shown while a query is active. Always names the
 * actual scope ("the loaded catalogue") and the exact match count.
 */
export function searchResultsLine(query: string, matchCount: number): string {
  const n = clampCount(matchCount);
  const noun = n === 1 ? "match" : "matches";
  return `${n} ${noun} for \u201C${query}\u201D in the loaded catalogue`;
}

/**
 * The zero-results message. Distinguishes category-scoped from unscoped
 * emptiness so an empty category is never mistaken for a failed search.
 */
export function emptyResultsMessage(options: {
  query?: string | null;
  categoryName?: string | null;
}): string {
  const query = options.query?.trim() ?? "";
  const category = options.categoryName?.trim() ?? "";
  if (category !== "" && query !== "") {
    return `No matches for \u201C${query}\u201D in ${category.toUpperCase()} within the loaded catalogue.`;
  }
  if (category !== "") {
    return `No products in ${category.toUpperCase()} within the loaded catalogue.`;
  }
  return `No matches for \u201C${query}\u201D in the loaded catalogue.`;
}
