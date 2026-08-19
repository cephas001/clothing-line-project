// apps/api/src/infrastructure/caching/productReadCacheKeys.ts

// Deterministic, versioned cache-key derivation for the product read cache.
//
// Every entry lives under ONE versioned namespace (`product-read:v1:`). The key
// is a SHA-256 hash of the canonicalized effective read context, so:
//   - one logical request -> exactly one key (retries and equivalent queries
//     collapse onto the same entry);
//   - different read contexts (region, sales channel, category, search term,
//     pagination, expand/fields) can never collide.
//
// Canonicalization must be EXACTLY faithful to the effective inputs the
// Postgres projection uses (see PostgresProductReadRepository): fields the
// projection trims are trimmed here, fields it does NOT trim are kept verbatim,
// and defaults are clamped identically. If a query input does not change the
// projected result, folding it onto the same key is CORRECT (shared entry); if
// it does change the result it MUST change the key. Keeping this exact keeps
// the cache free of cross-context poisoning.
//
// Versioning: `v1` is part of the namespace. Any future change to the key
// derivation, the cached payload shape, or the projection semantics MUST bump
// the namespace version so stale entries from the previous version can never be
// read. The hash itself is also echoed inside every cached envelope
// (productReadCacheSerialization) as defense-in-depth against a payload being
// stored under the wrong key.
//
// Runtime invalidation (L9 Part 3): every key also embeds a monotonic
// GENERATION (`product-read:v1:<generation>:<hash>`, generation folded into the
// hashed canonical too). Invalidating the read cache means INCRementing the
// generation counter (see ProductReadCacheInvalidator): all keys derived under
// the previous generation become unreachable and are reaped by their TTL. This
// is O(1), never scans Redis, and never deletes keys — a coherent
// namespace/version invalidation rather than a blind flush.

import { createHash } from "node:crypto";
import type { ProductReadQuery } from "@api/domain/shared/contracts";

/** Single versioned namespace for every product read cache entry. */
export const PRODUCT_READ_CACHE_NAMESPACE = "product-read:v1:";

/**
 * Redis key holding the monotonic generation counter. Reads derive their key
 * from the current value; catalog/pricing/inventory mutations INCR it so every
 * subsequent key differs and previously cached entries are orphaned.
 */
export const PRODUCT_READ_GENERATION_KEY = "product-read:generation";

export interface ProductReadCacheKey {
  /** Full Redis key (namespace + hash). */
  key: string;
  /** The hash echoed inside the cached envelope for the integrity check. */
  hash: string;
}

/** A string kept verbatim (the Postgres projection does NOT trim it). */
function rawString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A string trimmed; empty collapses to undefined. */
function canonicalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * A string array sorted, de-duplicated and trimmed. Order does not matter to
 * the projection (membership checks only), so equivalent orderings fold onto
 * one key.
 */
function canonicalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const cleaned = value
    .filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim() !== "",
    )
    .map((entry) => entry.trim());
  if (cleaned.length === 0) {
    return undefined;
  }
  return [...new Set(cleaned)].sort();
}

/** Faithful clamp of the projection's `Math.max(1, Math.min(limit ?? 20, 200))`. */
function canonicalLimit(value: unknown): number {
  if (typeof value !== "number") {
    return 20;
  }
  return Math.max(1, Math.min(value, 200));
}

/** Faithful clamp of the projection's `Math.max(0, offset ?? 0)`. */
function canonicalOffset(value: unknown): number {
  if (typeof value !== "number") {
    return 0;
  }
  return Math.max(0, value);
}

function buildFindManyContext(query: ProductReadQuery): Record<string, unknown> {
  return {
    regionId: rawString(query.regionId),
    salesChannelId: rawString(query.salesChannelId),
    categoryId: canonicalString(query.categoryId),
    q: canonicalString(query.q ?? query.searchQuery),
    limit: canonicalLimit(query.limit),
    offset: canonicalOffset(query.offset),
    expand: canonicalStringArray(query.expand),
    fields: canonicalStringArray(query.fields),
  };
}

function buildFindByIdAndContextContext(
  productId: string,
  salesChannelId: string,
  regionId: string,
  expand?: string[],
  fields?: string[],
): Record<string, unknown> {
  return {
    productId: rawString(productId),
    salesChannelId: rawString(salesChannelId),
    regionId: rawString(regionId),
    expand: canonicalStringArray(expand),
    fields: canonicalStringArray(fields),
  };
}

/**
 * Deterministic JSON-ish serialization with recursively sorted object keys so
 * equivalent objects always produce the identical canonical string. Property
 * order in the caller's object literal can never influence the key.
 */
function stableStringify(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  const type = typeof value;
  if (type === "string") {
    return JSON.stringify(value);
  }
  if (type === "number" || type === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (type === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${stableStringify(entry)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return String(value);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function toKey(
  method: string,
  generation: string,
  context: Record<string, unknown>,
): ProductReadCacheKey {
  const hash = sha256Hex(`${method}:${generation}:${stableStringify(context)}`);
  return {
    key: `${PRODUCT_READ_CACHE_NAMESPACE}${generation}:${hash}`,
    hash,
  };
}

/**
 * Cache key for `IProductReadRepository.findMany`. `generation` is the current
 * value of `PRODUCT_READ_GENERATION_KEY` (reads default to "0" when the
 * counter has never been bumped).
 */
export function findManyCacheKey(
  query: ProductReadQuery,
  generation: string,
): ProductReadCacheKey {
  return toKey("findMany", generation, buildFindManyContext(query));
}

/**
 * Cache key for `IProductReadRepository.findByIdAndContext`. `generation` is
 * the current value of `PRODUCT_READ_GENERATION_KEY`.
 */
export function findByIdAndContextCacheKey(
  productId: string,
  salesChannelId: string,
  regionId: string,
  expand: string[] | undefined,
  fields: string[] | undefined,
  generation: string,
): ProductReadCacheKey {
  return toKey(
    "findByIdAndContext",
    generation,
    buildFindByIdAndContextContext(productId, salesChannelId, regionId, expand, fields),
  );
}