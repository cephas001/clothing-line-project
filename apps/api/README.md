# @clothing-line-project/api

Backend domain + application layer (Clean Architecture) and HTTP entry for the
clothing-line headless store. This package owns the domain entities, repository
and service **interfaces**, and all **use cases**; concrete Postgres/Kysely and
Redis adapters live under `src/infrastructure`, and the composition root under
`src/infrastructure/composition`.

> Companion guidance for AI tools: see the repository-root `AGENTS.md`.

## Running locally

`pnpm dev` from the repository root starts the real Express server on `:5000`
after bringing up Postgres/Redis, provisioning env files, and applying pending
forward-only migrations. The server serves the OpenAPI contract in
`openapi.yaml` (docs at `/api-docs`); a Prism mock of the same spec runs on
`:4010` via `pnpm --filter @clothing-line-project/api dev:mock`. See the root
`AGENTS.md` for the full command set.

## Product read cache (L9-T)

A read-through Redis cache over the Postgres-backed `IProductReadRepository`.
It short-circuits identical catalog **read** contexts only. It is deliberately
NOT a source of truth for anything financial.

### Architecture / wiring chain

Wired **only** at the API composition root (`bootstrapApplication` in
`src/infrastructure/composition/bootstrap.ts`) — never inside a use case or an
HTTP router:

```
PostgresProductReadRepository (source of truth)
   -> CachedProductReadRepository          (read decorator: cache-aside, fail-open)
        -> BrowseCatalogUseCase / GetProductDetailsUseCase

Postgres Product/Variant/MoneyAmount repositories (write side)
   -> Invalidating{Product,Variant,MoneyAmount}Repository   (bump generation on save)
        -> ProductReadCacheInvalidator     (INCR product-read:generation)
```

The **worker** runtime (`apps/worker`) calls `buildRepositories` directly and
therefore never constructs the decorator or the invalidating wrappers; runtimes
without product reads never require `PRODUCT_CACHE_TTL_SECONDS` or the product
cache keyspace. Redis in the worker exists for BullMQ queues and session
revocation only.

### Cache key versioning

- Namespace `product-read:v2:` — any change to key derivation, payload shape, or
  projection semantics MUST bump the version so old entries can never be read.
- Every key embeds a monotonic **generation**: `product-read:v2:<gen>:<hash>`.
  The generation is also folded into the SHA-256 hash
  (`sha256(method:generation:canonicalContext)`), so it is part of the key AND
  its integrity echo.
- `PRODUCT_READ_GENERATION_KEY = product-read:generation` holds the counter.
  Reads treat a missing counter as generation `0`; a non-numeric value as `0`.
- Context canonicalization is byte-faithful to `PostgresProductReadRepository`
  (region/salesChannel kept verbatim, `categoryId`/`q` trimmed, pagination
  clamped, `expand`/`fields` sorted + de-duplicated), so equivalent queries
  collapse and distinct contexts can never collide.

### Invalidation (generation/namespace versioning, not a flush)

`ProductReadCacheInvalidator.invalidate()` INCRs the generation. Every
subsequently derived key differs, so previously cached entries are **orphaned
and TTL-reaped** — O(1), no `KEYS` scan, no `DEL`. This is coherent
namespace/version invalidation, not a blind "invalidate everything."

Invalidation fires from `save()` on the three wrapped write repositories —
exactly the catalog/pricing/inventory mutation paths
(`CreateProductUseCase`, `CreateProductVariantUseCase`,
`ConfigureRegionalPricingUseCase`, `AdjustInventoryLevelUseCase`). Reservation
and checkout never write those repositories, so high-frequency inventory
movement cannot thrash the cache. Category/sales-channel/promotion writes do
not change cached payloads and are intentionally unwrapped.

### Failure behavior (fail-open everywhere)

- **GET / SET / DEL failures**: normalized via the shared
  `toRedisRepositoryError` convention (stable `RepositoryErrorCode`), logged,
  and the request proceeds against Postgres. The cache can never fail a read.
- **Generation unreadable**: the cache is skipped **entirely** — straight to
  source, nothing written under a guessed key.
- **Corrupt entries** (bad JSON, wrong kind, keyHash echo mismatch, or a
  payload violating a domain invariant enforced by the entity constructors):
  DELETED and re-fetched (self-healing on the next read).
- **Invalidation failure**: logged and swallowed — the triggering catalog write
  still commits; staleness is then bounded by the TTL.
- **Configuration**: `PRODUCT_CACHE_TTL_SECONDS` (default `60`) in `.env.example`;
  a non-positive value fails fast at startup. Keep the TTL short: it is a
  coherence window, and the correctness cost of serving a stale row is bounded
  by that window.

### Authoritative boundaries

The cache is never consulted (and can never be a source of truth) for:

- checkout price / payment amount (`Cart.computeAuthoritativeCheckoutBreakdown`,
  `Payment.amountMinor`),
- regional pricing (`IPricingService` resolves via `IMoneyAmountRepository`
  only),
- tax (`ITaxCalculationService` resolves via `IRegionRepository` only),
- promotion discounts (from the persisted `Promotion` config),
- shipping amounts (from the durable server-selected quote),
- inventory **reservation decisions** (always the authoritative Postgres
  `inventory_level`/`inventory_reservation` ledger).

`IProductReadRepository` is consumed only by `BrowseCatalogUseCase` and
`GetProductDetailsUseCase`. The financial checkout path is composed without any
`productReadRepository` dependency (pinned by tests).

### Observability events

Every cache decision is emitted as a **structured event** on the `ILogger`
meta (`event` field) — never raw keys, payloads, tokens, or credentials:

| Event | Level | Meaning |
| --- | --- | --- |
| `product_cache_hit` | debug | valid entry served without Postgres (routine telemetry) |
| `product_cache_miss` | debug | no entry; source consulted (routine telemetry) |
| `product_cache_corrupt` | warn | invalid entry discarded and re-fetched |
| `product_cache_read_error` | warn | GET failed; fail-open to Postgres (code = `RepositoryErrorCode`) |
| `product_cache_write_error` | warn | SET failed; cache write is best-effort |
| `product_cache_del_error` | warn | DEL failed while discarding a corrupt key |
| `product_cache_generation_error` | warn | generation unreadable; cache disabled |
| `product_cache_invalidate` | info | generation bumped after a catalog write |
| `product_cache_invalidate_error` | warn | INCR failed; TTL bounds staleness |

Hit/miss events live at **debug** and are suppressed under the default
`LOG_LEVEL=info` (set `LOG_LEVEL=debug` to observe them). Failures and
corruption stay at **warn** and are always visible.

Meta fields are restricted to `event`, `operation`, `hash` (opaque key hash),
`reason`, `code`, and `generation`.

### Files

- `src/infrastructure/caching/productReadCacheKeys.ts` — namespace, generation
  key, canonical context, key derivation.
- `src/infrastructure/caching/productReadCacheSerialization.ts` — envelopes,
  serialize/parse, invariant-guarded reconstruction.
- `src/infrastructure/caching/CachedProductReadRepository.ts` — the read
  decorator (fail-open, TTL, corrupt recovery, generation-aware).
- `src/infrastructure/caching/ProductReadCacheInvalidator.ts` — fail-open
  generation bump.
- `src/infrastructure/caching/InvalidatingCatalogRepositories.ts` — write-side
  wrappers (product/variant/moneyAmount), bump on `save()` only.
- `src/infrastructure/composition/bootstrap.ts` — composition-root wiring.

## Verification

```bash
pnpm --filter @clothing-line-project/api typecheck
pnpm --filter @clothing-line-project/api typecheck:tests
pnpm --filter @clothing-line-project/api test            # zero-dep harness (tests/run.ts)
pnpm --filter @clothing-line-project/api db:test         # needs live Postgres on :5433
pnpm --filter @clothing-line-project/shared-types generate   # after editing openapi.yaml
```
