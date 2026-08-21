# AGENTS.md

Guidance for AI tools and contributors working on this repository. Read this before making changes.

## Project overview

**Headless e-commerce monorepo** (Turborepo + pnpm workspace). Domain consists of:

- `apps/api` — Backend domain logic written in **Clean Architecture / Domain-Driven Design**. Contains domain entities, repository/service interfaces, all **use cases**, and the concrete adapters (`apps/api/src/infrastructure/` + `apps/api/src/adapters/`). The most mature, working part of the monorepo.
- `apps/storefront` — Next.js (App Router) storefront (Next 16, React 19, Tailwind v4). Custom demo UI (cart drawer, wishlist, checkout views, client contexts) over a hardcoded static catalog; no API integration yet.
- `apps/worker` — Background-worker runtime. Reuses the API's domain/application/infrastructure code (via `@api/*` tsconfig aliases) and composes the BullMQ workers (`PaymentEventWorker`, `LogisticsEventWorker`, `NotificationEventWorker`, `BulkCatalogImportWorker`). Workers contain no business logic; they invoke shared use cases.
- `packages/shared-types` — Generated TypeScript types from the OpenAPI spec (via `openapi-typescript`). `main`/`types` point directly at `src/index.ts` (no build step).
- `packages/config` — Empty placeholder.

Tech stack: **pnpm**, **TypeScript**, **Turborepo**, Postgres 18 + Redis 7 via Docker Compose, Express 5 API, BullMQ workers, OpenAPI 3.0 (Stoplight Prism mock available via `dev:mock`).

## Commands

Run from repo root. This is a pnpm/Turbo monorepo — always scope package commands with `--filter`.

```bash
# Install dependencies
pnpm install

# Provision local .env files (DATABASE_URL derived from docker-compose.yml, a
# per-machine JWT_SECRET shared by API + worker, NEXT_PUBLIC_API_URL for the
# storefront, and LOG_PRETTY=true). Idempotent; never overwrites existing values.
pnpm setup

# Start infrastructure (Postgres + Redis, waiting for readiness), provision
# env, apply pending forward-only migrations (turbo `dev` task depends on
# `db:migrate`), then run ALL dev tasks in parallel (real Express API on
# :5000, worker, storefront on :3000).
pnpm dev

# Stop infrastructure (containers stay; local volumes persist)
pnpm stop

# Stop and wipe the Postgres/Redis volumes (DESTRUCTIVE — deletes local data)
pnpm clean

# Typecheck the API (the only meaningful verification; must exit 0)
pnpm --filter @clothing-line-project/api typecheck

# Typecheck API src + tests (tests include worker QueueWorker files) and run
# the in-memory test suite; both must exit 0
pnpm --filter @clothing-line-project/api typecheck:tests
pnpm --filter @clothing-line-project/api test

# Run the real-Postgres suites (requires live Postgres + DATABASE_URL)
pnpm --filter @clothing-line-project/api db:test

# Typecheck the worker runtime (imports the API via @api/* aliases)
pnpm --filter @clothing-line-project/worker typecheck

# Run ONLY the real API (Express on :5000) without the worker/storefront
pnpm --filter @clothing-line-project/api dev

# Mock the OpenAPI spec without any real backend (Prism on :4010)
pnpm --filter @clothing-line-project/api dev:mock

# Run the worker runtime (consumes BullMQ queues; needs Redis + Postgres up)
# `start` runs once, `dev` runs in watch mode
pnpm --filter @clothing-line-project/worker start
pnpm --filter @clothing-line-project/worker dev

# Regenerate shared types from the API OpenAPI spec
pnpm --filter @clothing-line-project/shared-types generate
```

`scripts/prepare-env.mjs` is the only file in `scripts/`. It idempotently
provisions `apps/api/.env`, `apps/worker/.env`, and `apps/storefront/.env.local`
without ever overwriting existing values: `DATABASE_URL` is regex-parsed from
`docker-compose.yml` (the single source of truth for Postgres credentials), one
random `JWT_SECRET` is generated per machine and shared between API and worker,
a stale Prism URL (`http://localhost:4010`) in `NEXT_PUBLIC_API_URL` is
normalized to `http://localhost:5000`, and `LOG_PRETTY=true` is set for pretty
local logs. Run it manually via `pnpm setup`; `pnpm dev` runs it before Turbo.

**Typechecking** is the primary validation gate for the domain layer. A zero-dependency test harness IS configured under `apps/api/tests` (`tests/harness/runner.ts` + `tests/harness/expect.ts`): `test` runs every suite via tsx, `typecheck:tests` typechecks src + tests (it may include `../worker/src/workers/QueueWorker.ts` and `../worker/src/workers/NotificationEventWorker.ts` so the API suite can exercise the real worker crash semantics), and `db:test` runs the real-Postgres suites (requires live Postgres + DATABASE_URL). Do not assume a framework like Jest/Vitest is installed. Verify domain changes with `typecheck`, `typecheck:tests`, and `test`; new suites must be registered in `apps/api/tests/run.ts`. The OpenAPI spec (`apps/api/openapi.yaml`) is the source of truth for the HTTP contract; `dev` boots the real Express server and `dev:mock` runs a Prism mock from it.

## Monorepo layout

```
apps/
  api/            # Domain + application layer (primary work area) + infrastructure/HTTP adapters
  storefront/     # Next.js storefront (static demo catalog; no API integration yet)
  worker/         # Background-worker runtime (consumes BullMQ queues)
packages/
  config/         # Empty placeholder
  shared-types/   # openapi-typescript generated types (src/index.ts, no build step)
scripts/
  prepare-env.mjs # Idempotent local .env provisioning (pnpm setup / pnpm dev)
docs/             # Design PDFs + working notes (git-ignored)
pnpm-workspace.yaml
turbo.json
docker-compose.yml
tsconfig.base.json
```

## API architecture (README for editing `apps/api`)

`apps/api` follows **Clean Architecture**. All concrete adapters live INSIDE the
API package — `src/infrastructure/` (Postgres/Kysely, Redis, services,
observability, composition) and `src/adapters/http/` (transport boundary) — and
are wired only at the composition root. There are NO separate
`apps/infrastructure` / `apps/adapters` packages; concrete implementations stay
out of `domain/`. Respect the boundaries.

```
src/
  server.ts                   # Express HTTP entry point (only top-level file)
  domain/
    entities/                 # Rich domain models with invariants (Cart, Order, ...)
      errors/DomainError.ts   # Domain error + ErrorCode union (single source of truth)
    interfaces/
      repositories/           # Persistence contracts (I*Repository)
      services/               # External/domain service contracts (I*Service)
      shared/                 # ILogger, IIdGenerator, ITransactionManager + errors/RepositoryError.ts
    shared/                   # contracts.ts, json.ts, workflow.ts, sourcing*, sourcingSnapshot.ts,
                              # shippingSnapshot.ts, dispatchStateMachine.ts, trackingStateMachine.ts,
                              # inventoryReservationKey.ts, jobs.ts, notifications.ts
  use-cases/
    admin/ cart/ catalog/ checkout/ customers/ inventory/ logistics/ notifications/
    # one file per use case, e.g. <Verb><Noun>UseCase.ts
  infrastructure/             # Concrete adapters: database/ (Kysely + migrations + repositories),
                              # redis/, services/, caching/ (product read cache), observability/,
                              # composition/ (bootstrap, config, repository/service + use-case wiring)
  adapters/
    http/                     # HTTP transport boundary: routers/, middleware/, errors.ts,
                              # projections.ts, index.ts barrel
  utils/                      # handleUtils.ts, moneyUtils.ts, taxUtils.ts
```

The OpenAPI 3.0 spec lives at `apps/api/openapi.yaml` (the source of truth for
the HTTP contract); `packages/shared-types` is generated from it.

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
- **Keys**: `product-read:v2:<generation>:<sha256(method:generation:canonicalContext)>`.
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

### Use-case composition diagnostics (DEV-OBS)

`buildUseCases` (in `apps/api/src/infrastructure/composition/useCases/`) reports
every constructed (wired) and skipped (unwired) use case at boot, and each
unwired entry is classified against the runtime being composed. There are FOUR
statuses — **wired**, **unavailable — missing infrastructure capability**,
**unavailable — missing configuration**, and **deferred by design**. The
classification is derived from the ACTUAL composition graph, never hardcoded
per use case:

- The capability catalog in `useCases/capabilities.ts`
  (`EXTERNAL_SERVICE_CAPABILITIES`) is the single source of truth for which
  domain service interfaces have a concrete adapter in the repository and which
  env var gates construction. **When you add or remove an adapter, update this
  catalog** or the diagnostics lie.
- A missing dependency NOT in the catalog (no adapter exists anywhere) is
  **missing infrastructure capability** in every runtime.
- An adapter that exists but was not constructed (its config env var is absent)
  is **missing configuration** in the API runtime.
- The Worker runtime passes `{ runtime: "worker" }` to `buildUseCases` and wires
  NO external services by design; use cases that depend on one are **deferred by
  design** there (they are synchronous API/storefront/admin HTTP flows). The
  L4/L5 invariant — the worker must never create shipments — is carried as a
  `note` on `DispatchOrderFulfillmentUseCase`.
- The API runtime passes `{ runtime: "api" }`; it has no deferred-by-design
  entries.
- Worker-level `unavailable` entries (e.g. `NotificationEventWorker`) carry the
  same vocabulary. `useCaseReportLines()` in `useCases/types.ts` renders both
  runtimes' `describe()` summaries consistently.

**BullMQ v6 note**: `Worker.run()` resolves only when the worker's main loop
exits (on close). `QueueWorker.start()` therefore fire-and-forgets `run()` and
gates on `waitUntilReady()`; it must NEVER `await run()` — that would block
`WorkerRegistry.startAll()` on the first worker and later workers would never
start consuming.

### Development console & logging (dev-obs logging)

Local `pnpm dev` runs API (:5000), worker, and storefront (:3000) through Turbo
(`--ui=tui`; falls back to stream prefixes in non-interactive terminals).
Both Pino runtimes render **human-readable single-line logs** in development and
**structured JSON** in production — one logger, one code path:

- `PinoLogger` (the single Pino init site) gains a `pino-pretty` worker-thread
  **transport** only when `pretty` is set. Redaction is applied by Pino BEFORE
  the transport, so pretty output masks the same secrets as JSON.
- The environment distinction is resolved in exactly one place:
  `resolveLogPretty` in `apps/api/src/infrastructure/composition/config.ts`.
  `LOG_PRETTY=true` forces pretty, `LOG_PRETTY=false` forces JSON, otherwise
  pretty only in an interactive non-production terminal. The local `.env` files
  provisioned by `scripts/prepare-env.mjs` set `LOG_PRETTY=true` (gitignored,
  overridable in the shell since dotenv never overwrites an existing env var).
  Never branch on environment elsewhere in the codebase.
- Runtime identity is logger-level context: each composition root passes
  `component: "api"` / `"worker"` to `buildInfrastructure`, emitted as a base
  field and surfaced as a `[api]`/`[worker]` prefix by the pretty transport.
  No domain entity or use case knows about logging context.
- `pino-pretty` is a devDependency of `@clothing-line-project/api` only (the
  package that initializes Pino); it is never a production transport.
- For a scrollback-friendly, prefix-based Turbo view in place of the TUI, run
  `pnpm exec turbo run dev --ui=stream` (each line is prefixed with its task,
  e.g. `api:` / `worker:` / `storefront:`).

### Worker runtime (`apps/worker`)

The background worker runtime lives in its own package and **imports** the API's
shared code via `@api/*` tsconfig path aliases (`apps/worker/tsconfig.json` →
`../api/src/*`). It must never duplicate a use case, repository, or service.
It composes the BullMQ workers (`PaymentEventWorker`, `LogisticsEventWorker`,
`NotificationEventWorker`, `BulkCatalogImportWorker`) via
`composition/workers.ts` (`buildWorkers`), manages their lifecycle with
`WorkerRegistry` (register/startAll/closeAll), and has its own composition
root (`apps/worker/src/bootstrap.ts`). The `NotificationEventWorker` consumes
`QUEUE_NAMES.notificationEvents` and dispatches through the shared
`INotificationService` (the Resend adapter is constructed ONLY via
`apps/api/src/infrastructure/composition/notificationService.ts`); it resolves
each job's outbox row by id and persists the dispatch receipt through
`ITransactionManager` in a short transaction — never a provider call inside a
transaction. Workers start only on explicit `runtime.start()` from
`apps/worker/src/index.ts` — never on import (`QueueWorker` pins BullMQ's
`autorun` to `false`, so construction stays side-effect-free). Validate with
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

Next.js App Router under `apps/storefront/src/app`. Next 16, React 19, Tailwind
CSS v4 (`@tailwindcss/postcss`), React Compiler enabled (`next.config.ts`). The
storefront is a static demo UI: a hardcoded catalog in `src/lib/product.ts`,
client contexts (`CartContext`, `WishlistContext`, `CurrencyContext`,
`ToastContext`), plus cart drawer / wishlist / checkout views. It does NOT
depend on `@clothing-line-project/shared-types` or call the API — `src/lib/types.ts`
re-exports the shared types via a relative path into `packages/shared-types/src`.
Build via `turbo run build`; lint via
`pnpm --filter @clothing-line-project/storefront lint`.

## Infra notes

- `docker-compose.yml` runs Postgres 18 (host port `5433`, db `commerce_db`) and Redis 7 (`6379`, AOF enabled), both with healthchecks. Root `pnpm dev` brings them up and waits for readiness (`--wait`).
- `pnpm dev` runs migrations via the turbo `dev` task's `dependsOn: ["db:migrate"]`; `pnpm stop` keeps volumes, `pnpm clean` wipes them.
- `pnpm-workspace.yaml` covers `apps/*` and `packages/*`; `pnpm` is pinned via root `devEngines.packageManager` (`pnpm ^11.18.0`, auto-download).
- `.gitignore` excludes `node_modules`, build outputs (`dist`, `.next`, `out`), env files, `docs/`, `.opencode/`, and local DB volumes.

## Rules for AI tools

1. **Never guess test tooling** — use `pnpm --filter @clothing-line-project/api typecheck` to validate changes to `apps/api`, and `pnpm --filter @clothing-line-project/worker typecheck` for `apps/worker`.
2. **Never add `runInTransaction` back** to repository interfaces; use `ITransactionManager`.
3. **Don't violate Clean Architecture boundaries** — keep entities pure; use cases orchestrate through interfaces; put concrete DB/HTTP adapters under `infrastructure/` and `adapters/`.
4. **Match existing conventions** — file-level header comments, JSDoc responsibility blocks, `I*Repository`/`I*Service` naming, import-base style per file, and error-code centralization in `DomainError.ts`.
5. **Idempotency and state transitions matter** in this domain (orders, carts, fulfillment, returns). Preserve existing business rules exactly when refactoring.
6. Update `packages/shared-types` only by running `openapi-typescript` after editing `apps/api/openapi.yaml` — never hand-edit `api-types.ts`.