// apps/api/src/infrastructure/caching/ProductReadCacheInvalidator.ts

// Namespace/version invalidation for the product read cache.
//
// Every product read cache key embeds a monotonic GENERATION (see
// productReadCacheKeys.ts). Invalidating the cache means INCRementing that
// generation: every subsequently derived key differs, so previously cached
// entries become unreachable and are reaped by their TTL. This is O(1), never
// scans Redis, and never deletes keys — it only changes the namespace future
// reads address. It is NOT a blind "invalidate everything" flush: orphaned
// entries expire naturally and no eager deletion ever happens.
//
// FAIL-OPEN: a Redis failure while invalidating is logged and swallowed. The
// catalog/pricing/inventory write that triggered it still succeeds; staleness
// is then bounded by the cache TTL (productCacheTtlSeconds) instead of being
// cut immediately. Invalidation is a cache-coherence courtesy, never a
// prerequisite for a write to commit.
//
// Observability (L9-T Part 4): structured events on the logger meta — only the
// new generation number and stable RepositoryError codes, never credentials or
// payloads:
//   product_cache_invalidate       generation bumped after a catalog write
//   product_cache_invalidate_error INCR failed; TTL now bounds staleness

import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { toRedisRepositoryError } from "@api/infrastructure/redis/errors";
import { PRODUCT_READ_GENERATION_KEY } from "./productReadCacheKeys";

/** Minimal Redis surface the invalidator needs; the shared ioredis client satisfies it. */
export interface ProductCacheInvalidationStore {
  incr(key: string): Promise<number>;
}

/** Cache-coherence hook invoked after a catalog/pricing/inventory mutation. */
export interface IProductReadCacheInvalidator {
  invalidate(): Promise<void>;
}

export interface ProductReadCacheInvalidatorOptions {
  /** The shared Redis client (or an in-memory fake in tests). */
  redis: ProductCacheInvalidationStore;
  logger: ILogger;
}

export class ProductReadCacheInvalidator
  implements IProductReadCacheInvalidator
{
  private readonly redis: ProductCacheInvalidationStore;
  private readonly logger: ILogger;

  constructor(options: ProductReadCacheInvalidatorOptions) {
    if (!options.redis) {
      throw new Error("ProductReadCacheInvalidator requires a Redis client.");
    }
    if (!options.logger) {
      throw new Error("ProductReadCacheInvalidator requires a logger.");
    }
    this.redis = options.redis;
    this.logger = options.logger;
  }

  /** Bump the generation. Never throws: invalidation must not fail a write. */
  async invalidate(): Promise<void> {
    try {
      const generation = await this.redis.incr(PRODUCT_READ_GENERATION_KEY);
      this.logger.info("Product read cache invalidated", {
        event: "product_cache_invalidate",
        generation,
      });
    } catch (err) {
      const normalized = toRedisRepositoryError(err);
      this.logger.warn(
        "Product read cache invalidation failed; TTL bounds staleness",
        { event: "product_cache_invalidate_error", code: normalized.code },
      );
    }
  }
}