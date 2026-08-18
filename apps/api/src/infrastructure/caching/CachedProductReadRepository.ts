// apps/api/src/infrastructure/caching/CachedProductReadRepository.ts

// Read-through Redis cache decorator over IProductReadRepository.
//
// Responsibilities:
//   - Cache-aside reads: GET the derived key -> on a VALID envelope return the
//     decoded domain entities without touching Postgres; on a MISS read the
//     source (Postgres) and SET a fresh envelope with a TTL.
//   - Corrupt entries (invalid JSON, wrong kind, keyHash echo mismatch, or a
//     payload violating a domain invariant) are DELETED and treated as a miss,
//     so a poisoned entry is self-healing on the very next read.
//   - FAIL-OPEN semantics: any Redis failure (CONNECTION/TIMEOUT/UNKNOWN) is
//     normalized via the shared `toRedisRepositoryError` convention and logged,
//     then the request proceeds against Postgres. The cache can never take
//     down the read path; Postgres remains the source of truth.
//
// Isolation:
//   - Keys are deterministic SHA-256 hashes of the canonicalized read context
//     (productReadCacheKeys.ts), so region/sales-channel/search/pagination
//     contexts can never collide.
//   - Every envelope echoes the key hash; a mismatched echo is treated as
//     corrupt (defense against a payload stored under the wrong key).
//
// Generation (L9-T Part 3):
//   - Every key embeds the monotonic product-read generation counter, so a
//     catalog/pricing/inventory mutation (ProductReadCacheInvalidator + the
//     Invalidating* repository decorators) orphans previously cached entries
//     WITHOUT scanning or deleting keys. A generation-read failure disables
//     the cache entirely (nothing written under a guessed key).
//
// Observability (L9-T Part 4):
//   - Every decision is emitted as a STRUCTURED event on the ILogger meta
//     (`event` field), so the cache is observable without logging raw keys,
//     payloads, or any sensitive/credential material — only operation names,
//     the opaque key hash, and stable RepositoryError codes. Event names:
//       product_cache_hit             valid entry served without Postgres  [debug]
//       product_cache_miss            no entry; source will be consulted   [debug]
//       product_cache_corrupt         invalid entry discarded and re-fetched [warn]
//       product_cache_read_error      GET failed; fail-open to Postgres    [warn]
//       product_cache_write_error     SET failed; cache write is best-effort [warn]
//       product_cache_del_error       DEL failed while discarding a corrupt key [warn]
//       product_cache_generation_error generation unreadable; cache disabled [warn]
//   - Routine hit/miss telemetry lives at DEBUG (suppressed under the default
//     "info" LOG_LEVEL); failures and corruption stay at WARN so they are
//     always visible. Structured metadata (operation, hash, code) is preserved
//     at every level.
//
// Construction:
//   - `redis` is a minimal structural interface (get/set/del) satisfied by the
//     shared ioredis client but also by an in-memory fake, keeping the
//     decorator unit-testable without a live Redis. It never opens its own
//     connection and is safe to wrap around the Postgres repository at the
//     composition root (bootstrapApplication — NEVER inside a use case or
//     HTTP router).

import type { Product } from "@api/domain/entities/Product";
import type { IProductReadRepository } from "@api/domain/interfaces/repositories/IProductReadRepository";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { ProductReadQuery } from "@api/domain/shared/contracts";
import { toRedisRepositoryError } from "@api/infrastructure/redis/errors";
import {
  PRODUCT_READ_GENERATION_KEY,
  findByIdAndContextCacheKey,
  findManyCacheKey,
} from "./productReadCacheKeys";
import {
  parseProductCacheEnvelope,
  serializeProductDetailEnvelope,
  serializeProductListEnvelope,
} from "./productReadCacheSerialization";

/** Minimal Redis surface the decorator needs; the shared ioredis client and test fakes both satisfy it. */
export interface ProductCacheRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

const DEFAULT_TTL_SECONDS = 60;

export interface CachedProductReadRepositoryOptions {
  /** The authoritative Postgres-backed repository this decorator reads through. */
  source: IProductReadRepository;
  /** The shared Redis client (or an in-memory fake in tests). */
  redis: ProductCacheRedis;
  /** Logger for fail-open and corrupt-entry diagnostics. */
  logger: ILogger;
  /** Cache TTL in seconds. Default: 60. */
  ttlSeconds?: number;
}

export class CachedProductReadRepository implements IProductReadRepository {
  private readonly source: IProductReadRepository;
  private readonly redis: ProductCacheRedis;
  private readonly logger: ILogger;
  private readonly ttlSeconds: number;

  constructor(options: CachedProductReadRepositoryOptions) {
    if (!options.source) {
      throw new Error(
        "CachedProductReadRepository requires a source repository.",
      );
    }
    if (!options.redis) {
      throw new Error("CachedProductReadRepository requires a Redis client.");
    }
    if (!options.logger) {
      throw new Error("CachedProductReadRepository requires a logger.");
    }
    this.source = options.source;
    this.redis = options.redis;
    this.logger = options.logger;
    this.ttlSeconds =
      options.ttlSeconds && options.ttlSeconds > 0
        ? Math.floor(options.ttlSeconds)
        : DEFAULT_TTL_SECONDS;
  }

  async findMany(
    query: ProductReadQuery,
  ): Promise<{ items: Product[]; total: number }> {
    const generation = await this.readGeneration("findMany");
    if (generation === null) {
      // Cache control-plane unavailable (generation unknown): fail-open to the
      // source and write nothing.
      return this.source.findMany(query);
    }
    const { key, hash } = findManyCacheKey(query, generation);

    const cached = await this.readCached("findMany", key);
    if (cached.ok) {
      if (cached.value !== null) {
        const parsed = parseProductCacheEnvelope(cached.value, "product-list", hash);
        if (parsed.ok) {
          this.logCacheHit("findMany", hash);
          return parsed.value;
        }
        await this.deleteCached("findMany", key, hash, parsed.reason);
      } else {
        this.logCacheMiss("findMany", hash);
      }
    }

    const result = await this.source.findMany(query);
    await this.writeCached(
      "findMany",
      key,
      serializeProductListEnvelope(hash, result),
    );
    return result;
  }

  async findByIdAndContext(
    productId: string,
    salesChannelId: string,
    regionId: string,
    expand?: string[],
    fields?: string[],
  ): Promise<Product | null> {
    const generation = await this.readGeneration("findByIdAndContext");
    if (generation === null) {
      // Fail-open: the source is authoritative and needs no cache.
      return this.source.findByIdAndContext(
        productId,
        salesChannelId,
        regionId,
        expand,
        fields,
      );
    }
    const { key, hash } = findByIdAndContextCacheKey(
      productId,
      salesChannelId,
      regionId,
      expand,
      fields,
      generation,
    );

    const cached = await this.readCached("findByIdAndContext", key);
    if (cached.ok) {
      if (cached.value !== null) {
        const parsed = parseProductCacheEnvelope(
          cached.value,
          "product-detail",
          hash,
        );
        if (parsed.ok) {
          this.logCacheHit("findByIdAndContext", hash);
          return parsed.value;
        }
        await this.deleteCached("findByIdAndContext", key, hash, parsed.reason);
      } else {
        this.logCacheMiss("findByIdAndContext", hash);
      }
    }

    const product = await this.source.findByIdAndContext(
      productId,
      salesChannelId,
      regionId,
      expand,
      fields,
    );
    await this.writeCached(
      "findByIdAndContext",
      key,
      serializeProductDetailEnvelope(hash, product),
    );
    return product;
  }

  /**
   * The current cache generation, or `null` when Redis is unavailable (the
   * caller then skips the cache entirely). "0" is the initial namespace used
   * before any mutation has bumped the counter.
   */
  private async readGeneration(operation: string): Promise<string | null> {
    try {
      const raw = await this.redis.get(PRODUCT_READ_GENERATION_KEY);
      if (raw === null) {
        return "0";
      }
      return /^\d+$/.test(raw) ? raw : "0";
    } catch (err) {
      this.logCacheFailure(
        operation,
        "product_cache_generation_error",
        err,
      );
      return null;
    }
  }

  /** GET with fail-open: a Redis failure is logged and treated as a miss. */
  private async readCached(
    operation: string,
    key: string,
  ): Promise<{ ok: true; value: string | null } | { ok: false }> {
    try {
      return { ok: true, value: await this.redis.get(key) };
    } catch (err) {
      this.logCacheFailure(operation, "product_cache_read_error", err);
      return { ok: false };
    }
  }

  /** SET with fail-open: a cache write can never fail the read path. */
  private async writeCached(
    operation: string,
    key: string,
    value: string,
  ): Promise<void> {
    try {
      await this.redis.set(key, value, "EX", this.ttlSeconds);
    } catch (err) {
      this.logCacheFailure(operation, "product_cache_write_error", err);
    }
  }

  /** Best-effort removal of a corrupt entry; failures are fail-open too. */
  private async deleteCached(
    operation: string,
    key: string,
    hash: string,
    reason: string,
  ): Promise<void> {
    this.logger.warn(
      `Product read cache entry invalid; discarding (${operation})`,
      { event: "product_cache_corrupt", operation, hash, reason },
    );
    try {
      await this.redis.del(key);
    } catch (err) {
      this.logCacheFailure(operation, "product_cache_del_error", err);
    }
  }

  private logCacheHit(operation: string, hash: string): void {
    // Routine telemetry: emitted at DEBUG so it is suppressed under the default
    // "info" LOG_LEVEL. Errors/corruption above stay visible (warn/error).
    this.logger.debug("Product read cache hit", {
      event: "product_cache_hit",
      operation,
      hash,
    });
  }

  private logCacheMiss(operation: string, hash: string): void {
    this.logger.debug("Product read cache miss", {
      event: "product_cache_miss",
      operation,
      hash,
    });
  }

  private logCacheFailure(
    operation: string,
    event: string,
    err: unknown,
  ): void {
    const normalized = toRedisRepositoryError(err);
    this.logger.warn(
      `Product read cache unavailable; falling back to Postgres (${operation})`,
      { event, operation, code: normalized.code },
    );
  }
}