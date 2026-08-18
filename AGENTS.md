# AGENTS.md

Guidance for AI tools and contributors working on this repository. Read this before making changes.

## Project overview

**Headless e-commerce monorepo** (Turborepo + pnpm workspace). Domain consists of:

- `apps/api` — Backend domain logic written in **Clean Architecture / Domain-Driven Design**. Contains domain entities, repository/service interfaces, and all **use cases**. `apps/infrastructure`, `apps/adapters`, and `apps/storefront` are scaffolded but the domain + use-case layer of the API is the most mature, working part.
- `apps/storefront` — Next.js (App Router) storefront (16, React 19, Tailwind v4).
- `apps/worker` — Background-worker runtime. Reuses the API's domain/application/infrastructure code (via `@api/*` tsconfig aliases) and composes the BullMQ workers (`PaymentEventWorker`, `LogisticsEventWorker`, `NotificationEventWorker`, `BulkCatalogImportWorker`). Workers contain no business logic; they invoke shared use cases.
- `packages/shared-types` — Generated TypeScript types from the OpenAPI spec (via `openapi-typescript`). `main`/`types` point directly at `src/index.ts` (no build step).
- `packages/config` — Empty placeholder.

Tech stack: **pnpm**, **TypeScript**, **Turborepo**, Postgres 18 + Redis 7 via Docker Compose, OpenAPI 3.0 (Stoplight Prism mock).

## Commands

Run from repo root. This is a pnpm/Turbo monorepo — always scope package commands with `--filter`.

```bash
# Install dependencies
pnpm install

# Start infrastructure (Postgres + Redis) then all dev tasks
pnpm dev

# Stop infrastructure
pnpm stop

# Typecheck the API (the only meaningful verification; must exit 0)
pnpm --filter @clothing-line-project/api typecheck

# Typecheck the worker runtime (imports the API via @api/* aliases)
pnpm --filter @clothing-line-project/worker typecheck

# Run the API use cases / domain only (Express server, if present)
pnpm --filter @clothing-line-project/api dev:express

# Run the worker runtime (consumes BullMQ queues; needs Redis + Postgres up)
pnpm --filter @clothing-line-project/worker start

# Mock the OpenAPI spec without any real backend
pnpm --filter @clothing-line-project/api dev

# Regenerate shared types from the API OpenAPI spec
pnpm --filter @clothing-line-project/shared-types generate
```

**Typechecking** is the primary validation gate for the domain layer. A zero-dependency test harness IS configured under `apps/api/tests` (`tests/harness/runner.ts` + `tests/harness/expect.ts`): `test` runs every suite via tsx, `typecheck:tests` typechecks src + tests (it may include `../worker/src/workers/QueueWorker.ts` and `../worker/src/workers/NotificationEventWorker.ts` so the API suite can exercise the real worker crash semantics), and `db:test` runs the real-Postgres suites (requires live Postgres + DATABASE_URL). Do not assume a framework like Jest/Vitest is installed. Verify domain changes with `typecheck`, `typecheck:tests`, and `test`; new suites must be registered in `apps/api/tests/run.ts`. The OpenAPI spec (`apps/api/openapi.yaml`) is the source of truth for the HTTP contract; `dev` runs a Prism mock from it.

## Monorepo layout

```
apps/
  api/            # Domain + application layer (primary work area) + HTTP entry
  storefront/     # Next.js storefront
  worker/         # Background-worker runtime (consumes BullMQ queues)
packages/
  config/         # Empty
  shared-types/   # openapi-typescript generated types (src/index.ts)
docs/             # Design PDFs + working notes (git-ignored)
pnpm-workspace.yaml
turbo.json
docker-compose.yml
tsconfig.base.json
```

## API architecture (README for editing `apps/api`)

`apps/api` follows **Clean Architecture**. `apps/infrastructure` and `apps/adapters` are intentionally **empty** — this layer is designed to be surrogate-independent and dependency-injected. Respect the boundaries.

```
src/
  domain/
    entities/                 # Rich domain models with invariants (Cart, Order, ...)
      errors/DomainError.ts   # Domain error + ErrorCode union (single source of truth)
    interfaces/
      repositories/           # Persistence contracts (I*Repository)
      services/               # External/domain service contracts (I*Service)
      shared/                 # Cross-cutting contracts (ILogger, IIdGenerator, ITransactionManager, RepositoryError)
      shared/errors/RepositoryError.ts
    shared/                   # contracts.ts, json.ts (JsonValue/Object), workflow.ts
  use-cases/
    admin/ cart/ catalog/ checkout/ customers/ logistics/
    # one file per use case, e.g. <Verb><Noun>UseCase.ts
  infrastructure/             # Concrete adapters: Postgres/Kysely, Redis, services, observability, composition (HTTP runtime)
  adapters/                   # HTTP transport boundary (routers/, middleware/, errors.ts, projections.ts) + index.ts barrel
  utils/                      # handleUtils.ts, taxUtils.ts
```

### Product read cache (L9-T)

A read-through Redis cache lives under `src/infrastructure/caching/` and is
wired ONLY at the API composition root (`bootstrapApplication` in
`src/infrastructure/composition/bootstrap.ts`) — never inside use cases or
HTTP routers. See `apps/api/README.md` for the full write-up. Essentials:

- **Chain**: `PostgresProductReadRepository` → `CachedProductReadRepository`
  (cache-aside, fail-open) → `BrowseCatalogUseCase`/`GetProductDetailsUseCase`
  (the only consumers of `IProductReadRepository`). Write side:
  `Invalidating{Product,Variant,MoneyAmount}Repository` bump the generation
  counter (`product-read:generation`) after `save()` via the fail-open
  `ProductReadCacheInvalidator`.
- **Keys**: `product-read:v1:<generation>:<sha256(method:generation:canonicalContext)>`.
  Generation is part of the key AND the envelope hash echo. Versioning bumps on
  any key/payload/projection change. Invalidation is generation/namespace
  versioning — O(1) INCR, NEVER a `KEYS` scan or mass `DEL`; orphaned entries
  are TTL-reaped.
- **Failure behavior**: fail-open everywhere. GET/SET/DEL errors are normalized
  via `toRedisRepositoryError`, logged as structured events, and the read
  proceeds against Postgres. An unreadable generation disables the cache
  entirely (nothing written). Corrupt entries are DELETED and re-fetched.
  Invalidation failure never fails the triggering write (TTL then bounds
  staleness). TTL is config-driven: `PRODUCT_CACHE_TTL_SECONDS` (default 60).
- **Authoritative boundaries (never cache-as-truth)**: checkout/payment
  amounts, regional pricing, tax, promotions, shipping amounts, and inventory
  RESERVATION decisions always resolve from Postgres. Do not wrap pricing/tax/
  cart/reservation reads in the product cache. Do not make inventory
  availability cache-backed.
- **Worker**: `apps/worker` calls `buildRepositories` directly — no cache
  decorator, no `PRODUCT_CACHE_TTL_SECONDS` requirement. If a worker ever needs
  product reads, wire the decorator in the worker bootstrap, never in a use
  case.
- **Observability**: structured `event` fields on the logger meta
  (`product_cache_hit`, `product_cache_miss`, `product_cache_corrupt`,
  `product_cache_read_error`, `product_cache_write_error`,
  `product_cache_del_error`, `product_cache_generation_error`,
  `product_cache_invalidate`, `product_cache_invalidate_error`). Never log raw
  keys, payloads, tokens, or credentials. Routine hit/miss telemetry is emitted
  at **debug** (suppressed under the default `LOG_LEVEL=info`); failures,
  corruption, and invalidation stay at info/warn and remain visible.

### Worker runtime (`apps/worker`)

The background worker runtime lives in its own package and **imports** the API's
shared code via `@api/*` tsconfig path aliases (`apps/worker/tsconfig.json` →
`../api/src/*`). It must never duplicate a use case, repository, or service.
It composes the BullMQ workers (`PaymentEventWorker`, `LogisticsEventWorker`,
`NotificationEventWorker`, `BulkCatalogImportWorker`) and its own composition
root (`apps/worker/src/bootstrap.ts`). The `NotificationEventWorker` consumes
`QUEUE_NAMES.notificationEvents` and dispatches through the shared
`INotificationService` (the Resend adapter is constructed ONLY via
`apps/api/src/infrastructure/composition/notificationService.ts`); it resolves
each job's outbox row by id and persists the dispatch receipt through
`ITransactionManager` in a short transaction — never a provider call inside a
transaction. Workers start only on explicit `runtime.start()` from
`apps/worker/src/index.ts` — never on import. Validate with
`pnpm --filter @clothing-line-project/worker typecheck`.

### Guidelines

- **Entities** (`src/domain/entities/*.ts`) are pure domain models. They own business rules and invariants via methods (e.g. `Cart.markConverted()`, `ProductVariant.deductInventory()`). They throw `DomainError` for invalid state. They do not touch repositories, loggers, or databases.
- **Repository/Service interfaces** are abstract contracts only — no implementations live in this layer. Name pattern: `I<Noun>Repository`, `I<Verb>Service`.
- **Use cases** orchestrate: validate input → authorize (via `IAuthorizationService.authorizeAdmin`) → load aggregates via repository interfaces → apply domain methods → **persist through repository interfaces** → audit-log (non-blocking) → log. They map repository/DB errors to `DomainError` with stable `code`s.
- **Error mapping**: Convert `RepositoryError` codes (`CONNECTION`, `TIMEOUT`, `DUPLICATE`, `LOCKED`, `NOWAIT`, ...) into `DomainError` codes (`INTERNAL_ERROR`, `INVALID_OPERATION`, `LOCK_ACQUISITION_FAILED`, ...). Add new codes to the `ErrorCode` union in `DomainError.ts`.
- **Transaction handling**: Use the `ITransactionManager` abstraction. **Repositories must not own transaction orchestration** — no `runInTransaction` on repository interfaces. When a use case performs a write/atomic operation, it must be invoked through an injected `ITransactionManager`:
  ```ts
  await this.transactionManager.execute(async () => { await repo.save(...) });
  ```
  Inject `ITransactionManager` via the constructor (match the file's `readonly` style). Do not re-introduce conditional `if (repo.runInTransaction)` checks. The only repo-level lock primitive retained is `IVariantRepository.lockVariantForUpdateNoWait(variantId)` which operates inside the manager's transaction; it is **NOT** used by the L9 reservation path (which relies on atomic conditional `UPDATE inventory_level ... WHERE available_quantity >= ?` mutations via `IInventoryLevelRepository`) and remains available only for legitimate future use cases.
- **Consistency across files**: Some older files use import base `@api/...`, some use `#domain/...` (package `imports`). Match the existing file's import style and alias: `@api/domain/...`, `@api-domain-entities/...`, `#domain/...`, etc. Refer to `apps/api/tsconfig.json` `paths` and `apps/api/package.json` `imports`.

### Naming & TypeScript conventions

- TypeScript, strict mode (ES2020, `moduleResolution: bundler`), ESM.
- Idempotent by design; domain methods replace state.
- Keep `readonly` on constructor-injected dependencies to match each file's existing convention.
- Files start with a comment banner `// apps/api/src/...` and use JSDoc describing responsibilities.

## Storefront / Next.js

Next.js App Router under `apps/storefront/src/app`. Tailwind CSS v4 (`@tailwindcss/postcss`). Build via `turbo run build`. No global state or API integration layers are implemented yet.

## Infra notes

- `docker-compose.yml` runs Postgres 18 (host port `5433`) and Redis 7 (`6379`). Root `pnpm dev` brings them up.
- `.gitignore` excludes `node_modules`, build outputs (`dist`, `.next`), env files, `docs/`, and local DB volumes.

## Rules for AI tools

1. **Never guess test tooling** — use `pnpm --filter @clothing-line-project/api typecheck` to validate changes to `apps/api`, and `pnpm --filter @clothing-line-project/worker typecheck` for `apps/worker`.
2. **Never add `runInTransaction` back** to repository interfaces; use `ITransactionManager`.
3. **Don't violate Clean Architecture boundaries** — keep entities pure; use cases orchestrate through interfaces; put concrete DB/HTTP adapters under `infrastructure/` and `adapters/`.
4. **Match existing conventions** — file-level header comments, JSDoc responsibility blocks, `I*Repository`/`I*Service` naming, import-base style per file, and error-code centralization in `DomainError.ts`.
5. **Idempotency and state transitions matter** in this domain (orders, carts, fulfillment, returns). Preserve existing business rules exactly when refactoring.
6. Update `packages/shared-types` only by running `openapi-typescript` after editing `apps/api/openapi.yaml` — never hand-edit `api-types.ts`.