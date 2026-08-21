// apps/api/tests/unit/caching/ProductReadCache.test.ts
//
// L9 PART 2/3 — UNIT: CachedProductReadRepository (read-through Redis product
// read cache) + generation-based invalidation.
//
// The decorator MUST:
//   - be fail-open: a Redis failure never fails a read (Postgres is the source
//     of truth and the fallback);
//   - derive deterministic, context-isolated keys (equivalent queries collapse,
//     distinct read contexts can never collide);
//   - treat invalid cached payloads as corrupt: DELETED and re-fetched, with
//     domain invariants enforced by the entity constructors on the read path;
//   - cache negative lookups (product not found) with the same TTL;
//   - be generation-aware: keys embed the PRODUCT_READ_GENERATION_KEY counter,
//     a generation-read failure disables the cache entirely (no writes), and a
//     generation bump orphans every previously cached entry without deleting it.
//
// Uses an in-memory fake for BOTH the source repository and the Redis surface
// (get/set/del/incr), so no live Redis is needed.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { Cart } from "@api/domain/entities/Cart";
import { MoneyAmount } from "@api/domain/entities/MoneyAmount";
import { Product } from "@api/domain/entities/Product";
import { ProductMedia } from "@api/domain/entities/ProductMedia";
import { ProductVariant } from "@api/domain/entities/ProductVariant";
import { Region } from "@api/domain/entities/Region";
import type { IProductReadRepository } from "@api/domain/interfaces/repositories/IProductReadRepository";
import type { IMoneyAmountRepository } from "@api/domain/interfaces/repositories/IMoneyAmountRepository";
import type { IProductRepository } from "@api/domain/interfaces/repositories/IProductRepository";
import type { IRegionRepository } from "@api/domain/interfaces/repositories/IRegionRepository";
import type { IVariantRepository } from "@api/domain/interfaces/repositories/IVariantRepository";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { ProductReadQuery } from "@api/domain/shared/contracts";
import {
  CachedProductReadRepository,
  type ProductCacheRedis,
} from "@api/infrastructure/caching/CachedProductReadRepository";
import {
  InvalidatingMoneyAmountRepository,
  InvalidatingProductRepository,
  InvalidatingVariantRepository,
} from "@api/infrastructure/caching/InvalidatingCatalogRepositories";
import {
  ProductReadCacheInvalidator,
  type ProductCacheInvalidationStore,
} from "@api/infrastructure/caching/ProductReadCacheInvalidator";
import {
  PRODUCT_READ_GENERATION_KEY,
  findByIdAndContextCacheKey,
  findManyCacheKey,
} from "@api/infrastructure/caching/productReadCacheKeys";
import { serializeProductListEnvelope } from "@api/infrastructure/caching/productReadCacheSerialization";
import { RegionalPricingService } from "@api/infrastructure/services/RegionalPricingService";
import { RegionalTaxCalculationService } from "@api/infrastructure/services/RegionalTaxCalculationService";
import { buildCheckoutCart } from "../../fixtures/cartFactory";
import { buildFixedPromotion } from "../../fixtures/promotionFactory";
import { NoopLogger } from "../../fakes/NoopLogger";
import { RecordingLogger } from "../../fakes/RecordingLogger";

function makeProduct(id: string, channel: string): Product {
  const variant = new ProductVariant({
    id: `v-${id}`,
    productId: id,
    sku: `SKU-${id}`,
    inventoryQuantity: 5,
    allowBackorder: true,
    version: 3,
  });
  return new Product({
    id,
    title: `Product ${id}`,
    handle: `product-${id}`,
    description: `Desc ${id}`,
    variants: [variant],
    categoryIds: [`cat-${id}`],
    salesChannelIds: [channel],
    media: [
      new ProductMedia({
        id: `m-${id}-1`,
        url: `/products/${id}-1.jpg`,
        kind: "image",
        altText: `Product ${id} shot`,
        sortOrder: 0,
      }),
    ],
  });
}

function makeVariant(id: string, productId: string): ProductVariant {
  return new ProductVariant({
    id,
    productId,
    sku: `SKU-${id}`,
    inventoryQuantity: 4,
    allowBackorder: false,
    version: 1,
  });
}

function makeMoneyAmount(
  id: string,
  variantId: string,
  regionId: string,
  amountMinor: number,
): MoneyAmount {
  return new MoneyAmount({ id, variantId, regionId, amountMinor });
}

class FakeSource implements IProductReadRepository {
  public findManyCalls = 0;
  public detailCalls = 0;
  constructor(
    private readonly products: Product[],
    private readonly detail: Map<string, Product>,
  ) {}

  async findMany(
    _query: ProductReadQuery,
  ): Promise<{ items: Product[]; total: number }> {
    this.findManyCalls += 1;
    return { items: this.products, total: this.products.length };
  }

  async findByIdAndContext(
    productId: string,
    _salesChannelId: string,
    _regionId: string,
  ): Promise<Product | null> {
    this.detailCalls += 1;
    return this.detail.get(productId) ?? null;
  }
}

class FakeRedis
  implements ProductCacheRedis, ProductCacheInvalidationStore
{
  public readonly store = new Map<string, string>();
  /** Key -> expiry timestamp in fake-seconds; entries without one never expire. */
  public readonly ttl = new Map<string, number>();
  /** Monotonic fake clock, advanced by `tick`. */
  public now = 0;
  public setCalls: Array<{ key: string; mode: string; ttl: number }> = [];
  public delCalls: string[] = [];
  public incrCalls: string[] = [];
  /** Fails the NEXT get (any key) — exercises the generation-read failure path. */
  public failNextGet = false;
  /** Fails the next get on a cache entry (NOT the generation key). */
  public failCacheGet = false;
  public failNextSet = false;
  public failNextIncr = false;

  /** Advance the fake clock; cached entries past their TTL expire lazily on get. */
  tick(seconds: number): void {
    this.now += seconds;
  }

  async get(key: string): Promise<string | null> {
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new Error("connect ECONNREFUSED fake redis");
    }
    if (this.failCacheGet && key.startsWith("product-read:v2:")) {
      this.failCacheGet = false;
      throw new Error("timeout fake redis get");
    }
    if (this.store.has(key)) {
      const expiry = this.ttl.get(key);
      if (expiry !== undefined && this.now >= expiry) {
        this.store.delete(key);
        this.ttl.delete(key);
        return null;
      }
      return this.store.get(key) ?? null;
    }
    return null;
  }

  async set(
    key: string,
    value: string,
    mode: "EX",
    ttl: number,
  ): Promise<unknown> {
    this.setCalls.push({ key, mode, ttl });
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error("getaddrinfo ENOTFOUND fake redis");
    }
    this.store.set(key, value);
    this.ttl.set(key, this.now + ttl);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    this.delCalls.push(...keys);
    let removed = 0;
    for (const key of keys) {
      if (this.store.delete(key)) {
        removed += 1;
      }
      this.ttl.delete(key);
    }
    return removed;
  }

  async incr(key: string): Promise<number> {
    this.incrCalls.push(key);
    if (this.failNextIncr) {
      this.failNextIncr = false;
      throw new Error("connection refused fake redis incr");
    }
    const current = parseInt(this.store.get(key) ?? "0", 10);
    const next = (Number.isFinite(current) ? current : 0) + 1;
    // The generation counter is written directly (no TTL) so it persists.
    this.store.set(key, String(next));
    return next;
  }
}

function buildDecorator(
  source: IProductReadRepository,
  redis: ProductCacheRedis,
  ttlSeconds?: number,
  logger: ILogger = new NoopLogger(),
): CachedProductReadRepository {
  return new CachedProductReadRepository({
    source,
    redis,
    logger,
    ttlSeconds,
  });
}

describe("CachedProductReadRepository — cache-aside read-through", () => {
  it("returns the source result and populates the cache on a miss", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const decorator = buildDecorator(source, redis);

    const first = await decorator.findMany({ regionId: "region-1" });
    expect(first.items).toHaveLength(1);
    expect(first.total).toBe(1);
    expect(source.findManyCalls).toBe(1);

    const second = await decorator.findMany({ regionId: "region-1" });
    expect(second.items).toHaveLength(1);
    expect(second.total).toBe(1);
    // Second read is served from the cache: the source was NOT hit again.
    expect(source.findManyCalls).toBe(1);

    expect(redis.setCalls).toHaveLength(1);
    expect(redis.setCalls[0].mode).toBe("EX");
    expect(redis.setCalls[0].ttl).toBe(60);
    expect(redis.setCalls[0].key.startsWith("product-read:v2:")).toBe(true);
  });

  it("honors a custom ttlSeconds", async () => {
    const source = new FakeSource([], new Map());
    const redis = new FakeRedis();
    const decorator = buildDecorator(source, redis, 120);

    await decorator.findMany({});
    expect(redis.setCalls).toHaveLength(1);
    expect(redis.setCalls[0].ttl).toBe(120);
  });

  it("caches a findByIdAndContext miss (null product) and serves it from cache", async () => {
    const source = new FakeSource([], new Map());
    const redis = new FakeRedis();
    const decorator = buildDecorator(source, redis);
    const { key } = findByIdAndContextCacheKey("p-missing", "channel-1", "region-1", undefined, undefined, "0");

    const first = await decorator.findByIdAndContext(
      "p-missing",
      "channel-1",
      "region-1",
    );
    expect(first).toBeNull();
    expect(source.detailCalls).toBe(1);

    const second = await decorator.findByIdAndContext(
      "p-missing",
      "channel-1",
      "region-1",
    );
    expect(second).toBeNull();
    expect(source.detailCalls).toBe(1);
    expect(redis.store.has(key)).toBe(true);
  });

  it("round-trips a cached detail into identical domain entities", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const decorator = buildDecorator(source, redis);

    await decorator.findByIdAndContext("p1", "channel-1", "region-1");
    expect(source.detailCalls).toBe(1);

    const cached = await decorator.findByIdAndContext(
      "p1",
      "channel-1",
      "region-1",
    );
    expect(source.detailCalls).toBe(1);
    expect(cached).toBeInstanceOf(Product);
    expect(cached!.id).toBe("p1");
    expect(cached!.title).toBe("Product p1");
    expect(cached!.handle).toBe("product-p1");
    expect(cached!.description).toBe("Desc p1");
    expect(cached!.categoryIds).toEqual(["cat-p1"]);
    expect(cached!.salesChannelIds).toEqual(["channel-1"]);
    expect(cached!.media).toHaveLength(1);
    expect(cached!.media[0].id).toBe("m-p1-1");
    expect(cached!.media[0].url).toBe("/products/p1-1.jpg");
    expect(cached!.media[0].altText).toBe("Product p1 shot");
    expect(cached!.media[0].sortOrder).toBe(0);
    expect(cached!.variants).toHaveLength(1);
    expect(cached!.variants[0].sku).toBe("SKU-p1");
    expect(cached!.variants[0].inventoryQuantity).toBe(5);
    expect(cached!.variants[0].allowBackorder).toBe(true);
    expect(cached!.variants[0].version).toBe(3);
  });
});

describe("CachedProductReadRepository — corruption is discarded and re-fetched", () => {
  it("treats non-JSON as corrupt: deletes it and falls back to the source", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const decorator = buildDecorator(source, redis);

    const { key } = findManyCacheKey({ regionId: "region-1" }, "0");
    redis.store.set(key, "this is not json");

    const result = await decorator.findMany({ regionId: "region-1" });
    expect(result.items).toHaveLength(1);
    expect(source.findManyCalls).toBe(1);
    expect(redis.delCalls.includes(key)).toBe(true);
    // A fresh envelope replaced the corrupt one.
    expect(redis.store.has(key)).toBe(true);
    expect(redis.setCalls).toHaveLength(1);
  });

  it("treats a keyHash echo mismatch as corrupt", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const decorator = buildDecorator(source, redis);

    // A structurally VALID envelope stored under the right key, but echoing the
    // wrong hash: the integrity check must reject it.
    const { key } = findManyCacheKey({ regionId: "region-1" }, "0");
    redis.store.set(
      key,
      serializeProductListEnvelope("not-the-correct-hash", {
        items: [product],
        total: 1,
      }),
    );

    const result = await decorator.findMany({ regionId: "region-1" });
    expect(result.items).toHaveLength(1);
    expect(source.findManyCalls).toBe(1);
    expect(redis.delCalls.includes(key)).toBe(true);
  });

  it("rejects a payload that violates a domain invariant (inventory over the maximum)", async () => {
    const source = new FakeSource([], new Map());
    const redis = new FakeRedis();
    const decorator = buildDecorator(source, redis);

    const { key, hash } = findByIdAndContextCacheKey(
      "p1",
      "channel-1",
      "region-1",
      undefined,
      undefined,
      "0",
    );
    // inventoryQuantity 2_000_000_000 passes the type guards but exceeds
    // ProductVariant.MAX_INVENTORY (1_000_000_000): the constructor rejects it.
    redis.store.set(
      key,
      JSON.stringify({
        kind: "product-detail",
        keyHash: hash,
        data: {
          id: "p1",
          title: "P1",
          handle: "p1",
          description: null,
          variants: [
            {
              id: "v1",
              productId: "p1",
              sku: "S1",
              inventoryQuantity: 2_000_000_000,
              allowBackorder: true,
              version: 0,
            },
          ],
          categoryIds: [],
          salesChannelIds: ["channel-1"],
        },
      }),
    );

    const result = await decorator.findByIdAndContext(
      "p1",
      "channel-1",
      "region-1",
    );
    expect(result).toBeNull();
    expect(source.detailCalls).toBe(1);
    expect(redis.delCalls.includes(key)).toBe(true);
  });
});

describe("CachedProductReadRepository — fail-open on Redis failures", () => {
  it("a generation GET failure disables the cache: the source is used and nothing is written", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const decorator = buildDecorator(source, redis);

    redis.failNextGet = true;
    const result = await decorator.findMany({ regionId: "region-1" });
    expect(result.items).toHaveLength(1);
    expect(source.findManyCalls).toBe(1);
    // The generation is unknown, so NOTHING may be written under a guessed key.
    expect(redis.setCalls).toHaveLength(0);
  });

  it("a cache GET failure (generation readable) is a miss: falls back to the source and still repopulates", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const decorator = buildDecorator(source, redis);

    redis.failCacheGet = true;
    const first = await decorator.findMany({ regionId: "region-1" });
    expect(first.items).toHaveLength(1);
    expect(source.findManyCalls).toBe(1);
    // The miss write still succeeded (generation was known), so the second
    // read is served from cache.
    const second = await decorator.findMany({ regionId: "region-1" });
    expect(second.items).toHaveLength(1);
    expect(source.findManyCalls).toBe(1);
  });

  it("a SET failure never fails the read; the next read simply hits the source again", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const decorator = buildDecorator(source, redis);

    redis.failNextSet = true;
    const first = await decorator.findMany({ regionId: "region-1" });
    expect(first.items).toHaveLength(1);
    expect(source.findManyCalls).toBe(1);

    const second = await decorator.findMany({ regionId: "region-1" });
    expect(second.items).toHaveLength(1);
    // Nothing was cached (the set failed), so the source served the second read.
    expect(source.findManyCalls).toBe(2);
  });
});

describe("productReadCacheKeys — deterministic, context-isolated, generation-aware keys", () => {
  it("is deterministic for the same effective context and generation", () => {
    const a = findManyCacheKey({ regionId: "r1", salesChannelId: "c1", limit: 10 }, "0");
    const b = findManyCacheKey({ regionId: "r1", salesChannelId: "c1", limit: 10 }, "0");
    expect(a.key).toBe(b.key);
    expect(a.hash).toBe(b.hash);
  });

  it("isolates distinct regions and sales channels", () => {
    const r1 = findManyCacheKey({ regionId: "r1", salesChannelId: "c1" }, "0");
    const r2 = findManyCacheKey({ regionId: "r2", salesChannelId: "c1" }, "0");
    const c2 = findManyCacheKey({ regionId: "r1", salesChannelId: "c2" }, "0");
    expect(r1.key).not.toBe(r2.key);
    expect(r1.key).not.toBe(c2.key);
  });

  it("collapses equivalent inputs: q vs searchQuery, default pagination, array order", () => {
    expect(
      findManyCacheKey({ q: "  shirt " }, "0").key,
    ).toBe(findManyCacheKey({ searchQuery: "shirt" }, "0").key);

    expect(findManyCacheKey({}, "0").key).toBe(
      findManyCacheKey({ limit: 20, offset: 0 }, "0").key,
    );

    expect(
      findManyCacheKey({ expand: ["variants", "options"] }, "0").key,
    ).toBe(
      findManyCacheKey({ expand: ["options", "variants", "variants"] }, "0").key,
    );
  });

  it("keeps expand/fields distinct per read context", () => {
    const plain = findByIdAndContextCacheKey("p1", "c1", "r1", undefined, undefined, "0");
    const expanded = findByIdAndContextCacheKey("p1", "c1", "r1", ["variants"], undefined, "0");
    const fields = findByIdAndContextCacheKey("p1", "c1", "r1", undefined, [
      "id",
      "title",
    ], "0");
    expect(plain.key).not.toBe(expanded.key);
    expect(plain.key).not.toBe(fields.key);
  });

  it("separates keys across generations: the generation is part of key AND hash", () => {
    const g0 = findManyCacheKey({ regionId: "r1" }, "0");
    const g1 = findManyCacheKey({ regionId: "r1" }, "1");
    expect(g0.key).not.toBe(g1.key);
    expect(g0.hash).not.toBe(g1.hash);
    expect(g0.key.startsWith("product-read:v2:0:")).toBe(true);
    expect(g1.key.startsWith("product-read:v2:1:")).toBe(true);
  });
});

describe("CachedProductReadRepository — generation-bump invalidation", () => {
  it("after a generation bump the same read re-fetches from the source under a NEW key; the old entry is orphaned, never deleted", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const decorator = buildDecorator(source, redis);
    const invalidator = new ProductReadCacheInvalidator({
      redis,
      logger: new NoopLogger(),
    });

    // Populate the cache under the initial (implicit "0") generation.
    await decorator.findMany({ regionId: "region-1" });
    expect(source.findManyCalls).toBe(1);
    const g0Key = findManyCacheKey({ regionId: "region-1" }, "0").key;
    expect(redis.store.has(g0Key)).toBe(true);

    // A mutation bumps the generation...
    await invalidator.invalidate();
    expect(redis.store.get(PRODUCT_READ_GENERATION_KEY)).toBe("1");

    // ...so the SAME read context now derives a different key and the source is
    // authoritative again. The old entry is still physically present (orphaned,
    // TTL-reaped) but is never read.
    const result = await decorator.findMany({ regionId: "region-1" });
    expect(result.items).toHaveLength(1);
    expect(source.findManyCalls).toBe(2);
    expect(redis.store.has(g0Key)).toBe(true);
    const g1Key = findManyCacheKey({ regionId: "region-1" }, "1").key;
    expect(redis.store.has(g1Key)).toBe(true);
    // No key deletion ever happens: invalidation is namespace/version-based.
    expect(redis.delCalls).toHaveLength(0);
  });

  it("an empty generation counter (never bumped) is treated as generation 0", async () => {
    const source = new FakeSource([], new Map());
    const redis = new FakeRedis();
    const decorator = buildDecorator(source, redis);

    await decorator.findMany({ regionId: "region-1" });
    expect(redis.setCalls[0].key.startsWith("product-read:v2:0:")).toBe(true);
  });
});

describe("ProductReadCacheInvalidator — fail-open generation bump", () => {
  it("increments the generation counter and records the new value", async () => {
    const redis = new FakeRedis();
    const invalidator = new ProductReadCacheInvalidator({
      redis,
      logger: new NoopLogger(),
    });

    await invalidator.invalidate();
    expect(redis.incrCalls).toEqual([PRODUCT_READ_GENERATION_KEY]);
    expect(redis.store.get(PRODUCT_READ_GENERATION_KEY)).toBe("1");

    await invalidator.invalidate();
    expect(redis.store.get(PRODUCT_READ_GENERATION_KEY)).toBe("2");
  });

  it("a Redis failure never throws and does not fail the caller", async () => {
    const redis = new FakeRedis();
    const invalidator = new ProductReadCacheInvalidator({
      redis,
      logger: new NoopLogger(),
    });
    redis.failNextIncr = true;

    let rejected = false;
    try {
      await invalidator.invalidate();
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(false);
  });
});

describe("InvalidatingCatalogRepositories — invalidate on save only", () => {
  it("productRepository.save bumps the generation; read methods never do", async () => {
    const redis = new FakeRedis();
    const invalidator = new ProductReadCacheInvalidator({
      redis,
      logger: new NoopLogger(),
    });
    let saved: Product | null = null;
    const source: IProductRepository = {
      async findByHandle() {
        return null;
      },
      async findById() {
        return null;
      },
      async save(p) {
        saved = p;
      },
    };
    const decorated = new InvalidatingProductRepository(source, invalidator);

    await decorated.findByHandle("h");
    await decorated.findById("p1");
    expect(redis.incrCalls).toHaveLength(0);

    await decorated.save(makeProduct("p1", "channel-1"));
    expect(saved).not.toBeNull();
    expect(redis.incrCalls).toEqual([PRODUCT_READ_GENERATION_KEY]);
  });

  it("variantRepository.save bumps the generation; lock/read methods never do", async () => {
    const redis = new FakeRedis();
    const invalidator = new ProductReadCacheInvalidator({
      redis,
      logger: new NoopLogger(),
    });
    let saved: ProductVariant | null = null;
    const source: IVariantRepository = {
      async findBySku() {
        return null;
      },
      async findById() {
        return null;
      },
      async lockVariantForUpdateNoWait() {
        return null;
      },
      async save(v) {
        saved = v;
      },
    };
    const decorated = new InvalidatingVariantRepository(source, invalidator);

    await decorated.findBySku("SKU");
    await decorated.findById("v1");
    await decorated.lockVariantForUpdateNoWait("v1");
    expect(redis.incrCalls).toHaveLength(0);

    await decorated.save(makeVariant("v1", "p1"));
    expect(saved).not.toBeNull();
    expect(redis.incrCalls).toEqual([PRODUCT_READ_GENERATION_KEY]);
  });

  it("moneyAmountRepository.save bumps the generation; read methods never do", async () => {
    const redis = new FakeRedis();
    const invalidator = new ProductReadCacheInvalidator({
      redis,
      logger: new NoopLogger(),
    });
    let saved: MoneyAmount | null = null;
    const source: IMoneyAmountRepository = {
      async findById() {
        return null;
      },
      async findRegionalPrice() {
        return null;
      },
      async save(m) {
        saved = m;
      },
    };
    const decorated = new InvalidatingMoneyAmountRepository(source, invalidator);

    await decorated.findById("m1");
    await decorated.findRegionalPrice("v1", "r1");
    expect(redis.incrCalls).toHaveLength(0);

    await decorated.save(makeMoneyAmount("m1", "v1", "r1", 1500));
    expect(saved).not.toBeNull();
    expect(redis.incrCalls).toEqual([PRODUCT_READ_GENERATION_KEY]);
  });

  it("a failed invalidation never fails the write (fail-open)", async () => {
    const redis = new FakeRedis();
    const invalidator = new ProductReadCacheInvalidator({
      redis,
      logger: new NoopLogger(),
    });
    let saveCount = 0;
    const source: IProductRepository = {
      async findByHandle() {
        return null;
      },
      async findById() {
        return null;
      },
      async save() {
        saveCount += 1;
      },
    };
    const decorated = new InvalidatingProductRepository(source, invalidator);
    redis.failNextIncr = true;

    let rejected = false;
    try {
      await decorated.save(makeProduct("p1", "channel-1"));
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(false);
    expect(saveCount).toBe(1);
  });
});

describe("Product read cache isolation — financial decisions never consult the cache", () => {
  it("RegionalPricingService resolves the price through IMoneyAmountRepository alone", async () => {
    const money = makeMoneyAmount("m1", "v1", "r1", 25000);
    const repo: IMoneyAmountRepository = {
      async findById(id) {
        return id === money.id ? money : null;
      },
      async findRegionalPrice(variantId, regionId) {
        return variantId === money.variantId && regionId === money.regionId
          ? money
          : null;
      },
      async save() {},
    };
    const pricing = new RegionalPricingService(repo);
    const price = await pricing.getPriceForRegion("v1", "r1");
    expect(price).toBe(25000);
    expect(pricing).toBeInstanceOf(RegionalPricingService);
  });

  it("RegionalTaxCalculationService resolves the rate through IRegionRepository alone and applies the single tax math", async () => {
    const region = new Region({
      id: "region-ng",
      name: "Nigeria",
      currencyCode: "NGN",
      taxRate: 750,
      paymentProviders: [],
      fulfillmentProviders: [],
    });
    const repo: IRegionRepository = {
      async findById(id) {
        return id === region.id ? region : null;
      },
      async save() {},
    };
    const tax = new RegionalTaxCalculationService(repo);
    const cart = buildCheckoutCart({ regionId: "region-ng" });
    const amount = await tax.calculateTaxForAddress(cart);
    // cartTotalMinor = 60_000; floor(60_000 * 750 / 10000) = 4_500.
    expect(amount).toBe(4500);
    expect(tax).toBeInstanceOf(RegionalTaxCalculationService);
  });

  it("Cart.computeAuthoritativeCheckoutBreakdown derives every component from server-persisted cart state", () => {
    const cart = buildCheckoutCart();
    const breakdown = cart.computeAuthoritativeCheckoutBreakdown();
    // Default fixture: subtotal 60_000, no discount, no tax/insurance,
    // durable shipping 2_500 -> total 62_500. Nothing is read from any cache.
    expect(breakdown.subtotalMinor).toBe(60_000);
    expect(breakdown.discountMinor).toBe(0);
    expect(breakdown.taxMinor).toBe(0);
    expect(breakdown.shippingMinor).toBe(2_500);
    expect(breakdown.insuranceMinor).toBe(0);
    expect(breakdown.totalMinor).toBe(62_500);
  });

  it("an applied promotion discount is read from the persisted promotion config, never from a cache", () => {
    const promotion = buildFixedPromotion("FLAT-5000", 5_000);
    const cart = buildCheckoutCart({ promotion });
    const breakdown = cart.computeAuthoritativeCheckoutBreakdown();
    expect(breakdown.subtotalMinor).toBe(60_000);
    expect(breakdown.discountMinor).toBe(5_000);
    expect(breakdown.totalMinor).toBe(62_500 - 5_000);
  });
});

describe("CachedProductReadRepository — TTL expiration", () => {
  it("an entry past its TTL is treated as a miss and repopulated under the same key", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const decorator = buildDecorator(source, redis, 60);

    await decorator.findMany({ regionId: "region-1" });
    expect(source.findManyCalls).toBe(1);
    expect(redis.setCalls[0].ttl).toBe(60);

    redis.tick(61);
    const again = await decorator.findMany({ regionId: "region-1" });
    expect(again.items).toHaveLength(1);
    // Expired -> source served the read and a FRESH envelope replaced the stale one.
    expect(source.findManyCalls).toBe(2);
    expect(redis.setCalls).toHaveLength(2);
    expect(redis.setCalls[1].ttl).toBe(60);
    expect(redis.setCalls[1].key).toBe(redis.setCalls[0].key);
  });

  it("an entry within its TTL keeps serving from cache", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const decorator = buildDecorator(source, redis, 60);

    await decorator.findMany({ regionId: "region-1" });
    expect(source.findManyCalls).toBe(1);

    redis.tick(59);
    await decorator.findMany({ regionId: "region-1" });
    expect(source.findManyCalls).toBe(1);
  });
});

describe("CachedProductReadRepository — Redis timeout classification", () => {
  it("a cache GET timeout is normalized to the TIMEOUT code and falls back to the source", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const logger = new RecordingLogger();
    const decorator = buildDecorator(source, redis, 60, logger);

    redis.failCacheGet = true;
    const result = await decorator.findMany({ regionId: "region-1" });
    expect(result.items).toHaveLength(1);
    expect(source.findManyCalls).toBe(1);
    // The timeout surfaces as a stable, non-sensitive RepositoryError code.
    expect(logger.eventsOf("product_cache_read_error")).toHaveLength(1);
    expect(logger.fieldOf("product_cache_read_error", "code")).toBe("TIMEOUT");
  });
});

describe("Product read cache — structured observability events", () => {
  it("emits product_cache_miss then product_cache_hit across two reads", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const logger = new RecordingLogger();
    const decorator = buildDecorator(source, redis, 60, logger);

    await decorator.findMany({ regionId: "region-1" });
    expect(source.findManyCalls).toBe(1);
    expect(logger.eventsOf("product_cache_miss")).toHaveLength(1);

    await decorator.findMany({ regionId: "region-1" });
    expect(source.findManyCalls).toBe(1);
    expect(logger.eventsOf("product_cache_hit")).toHaveLength(1);
    // Events carry the opaque key hash, never the payload or raw key bytes.
    expect(typeof logger.fieldOf("product_cache_hit", "hash")).toBe("string");
  });

  it("demotes routine hit/miss to debug but keeps failures/corruption visible", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const logger = new RecordingLogger();
    const decorator = buildDecorator(source, redis, 60, logger);

    // Routine telemetry: hit/miss are DEBUG level (suppressed under LOG_LEVEL=info).
    await decorator.findMany({ regionId: "region-1" });
    await decorator.findMany({ regionId: "region-1" });
    expect(logger.eventsOf("product_cache_miss")[0].level).toBe("debug");
    expect(logger.eventsOf("product_cache_hit")[0].level).toBe("debug");

    // Corrupt entries stay at WARN (must remain visible).
    const corruptRedis = new FakeRedis();
    const corruptLogger = new RecordingLogger();
    const corruptDecorator = buildDecorator(source, corruptRedis, 60, corruptLogger);
    const { key } = findManyCacheKey({ regionId: "region-1" }, "0");
    corruptRedis.store.set(key, "not json at all");
    await corruptDecorator.findMany({ regionId: "region-1" });
    expect(corruptLogger.eventsOf("product_cache_corrupt")[0].level).toBe("warn");

    // Redis failures stay at WARN.
    const failRedis = new FakeRedis();
    const failLogger = new RecordingLogger();
    const failDecorator = buildDecorator(source, failRedis, 60, failLogger);
    failRedis.failNextSet = true;
    await failDecorator.findMany({ regionId: "region-1" });
    expect(failLogger.eventsOf("product_cache_write_error")[0].level).toBe("warn");

    // Invalidation (a mutation event, not per-read telemetry) stays at INFO.
    const invalidatorRedis = new FakeRedis();
    const invalidatorLogger = new RecordingLogger();
    await new ProductReadCacheInvalidator({
      redis: invalidatorRedis,
      logger: invalidatorLogger,
    }).invalidate();
    expect(invalidatorLogger.eventsOf("product_cache_invalidate")[0].level).toBe(
      "info",
    );
  });

  it("emits product_cache_corrupt when an invalid entry is discarded", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const logger = new RecordingLogger();
    const decorator = buildDecorator(source, redis, 60, logger);

    const { key } = findManyCacheKey({ regionId: "region-1" }, "0");
    redis.store.set(key, "not json at all");

    const result = await decorator.findMany({ regionId: "region-1" });
    expect(result.items).toHaveLength(1);
    expect(logger.eventsOf("product_cache_corrupt")).toHaveLength(1);
    expect(redis.delCalls.includes(key)).toBe(true);
  });

  it("emits product_cache_write_error when the SET fails, without failing the read", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const logger = new RecordingLogger();
    const decorator = buildDecorator(source, redis, 60, logger);

    redis.failNextSet = true;
    const first = await decorator.findMany({ regionId: "region-1" });
    expect(first.items).toHaveLength(1);
    expect(source.findManyCalls).toBe(1);
    expect(logger.eventsOf("product_cache_write_error")).toHaveLength(1);
  });

  it("emits product_cache_generation_error when the generation is unreadable (cache disabled)", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const logger = new RecordingLogger();
    const decorator = buildDecorator(source, redis, 60, logger);

    redis.failNextGet = true;
    const result = await decorator.findMany({ regionId: "region-1" });
    expect(result.items).toHaveLength(1);
    expect(logger.eventsOf("product_cache_generation_error")).toHaveLength(1);
    // Cache disabled: nothing was written under a guessed key.
    expect(redis.setCalls).toHaveLength(0);
  });

  it("the invalidator emits product_cache_invalidate (and *_error on failure)", async () => {
    const redis = new FakeRedis();
    const logger = new RecordingLogger();
    const invalidator = new ProductReadCacheInvalidator({
      redis,
      logger,
    });

    await invalidator.invalidate();
    expect(logger.eventsOf("product_cache_invalidate")).toHaveLength(1);
    expect(logger.fieldOf("product_cache_invalidate", "generation")).toBe(1);

    redis.failNextIncr = true;
    await invalidator.invalidate();
    expect(logger.eventsOf("product_cache_invalidate_error")).toHaveLength(1);
  });

  it("never logs raw keys or credentials in any event meta", async () => {
    const product = makeProduct("p1", "channel-1");
    const source = new FakeSource([product], new Map([["p1", product]]));
    const redis = new FakeRedis();
    const logger = new RecordingLogger();
    const decorator = buildDecorator(source, redis, 60, logger);

    await decorator.findMany({ regionId: "region-1" });
    await decorator.findMany({ regionId: "region-1" });
    await new ProductReadCacheInvalidator({ redis, logger }).invalidate();

    const serialized = JSON.stringify(logger.logs);
    // Only stable event names, operation labels, hashes and error codes leak.
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("secret");
  });
});