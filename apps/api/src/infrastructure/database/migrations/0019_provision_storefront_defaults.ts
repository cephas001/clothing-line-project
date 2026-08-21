// apps/api/src/infrastructure/database/migrations/0019_provision_storefront_defaults.ts
//
// F4 PRE-IMPLEMENTATION (M3) — DEFAULT REGION + SALES CHANNEL PROVISIONING.
//
// The storefront's cart session endpoint (`POST /store/carts`) requires a
// `regionId` and `salesChannelId`; `InitializeCartSessionUseCase` rejects a
// request whose region/channel does not exist with RESOURCE_NOT_FOUND. There is
// no region-create endpoint and no public sales-channel listing, so a fresh
// `db:migrate` environment had NO way to obtain valid identifiers — the entire
// cart/checkout flow was blocked (the only region/channel rows historically
// came from test fixtures). This migration provisions the single canonical
// storefront context so `POST /store/carts` works out of the box:
//
//   - `reg-storefront`    — the default NGN region (Nigeria, 7.5% VAT = 750
//     basis points), Paystack as the payment provider and Shipbubble as the
//     fulfillment provider (the exact adapters the composition root wires).
//   - `channel-storefront` — the default storefront sales channel (enabled).
//
// Consistent with the 0016 convention for `loc-default`, the seed is idempotent
// (ON CONFLICT DO NOTHING) with deterministic ids so re-runs / partial replays
// are no-ops and every environment converges on the same identifiers. The ids
// are documented for local env provisioning (see scripts/prepare-env.mjs and
// docs/f4_pre_implementation_prerequisites.md).
//
// Down deletes only this migration's seeded rows — the true inverse of a pure
// data migration.

import { Kysely } from "kysely";

/** Canonical default storefront region id (documented for storefront env). */
export const DEFAULT_STOREFRONT_REGION_ID = "reg-storefront";
/** Canonical default storefront sales channel id (documented for storefront env). */
export const DEFAULT_STOREFRONT_SALES_CHANNEL_ID = "channel-storefront";

export async function up(db: Kysely<any>): Promise<void> {
  await db
    .insertInto("region")
    .values({
      id: DEFAULT_STOREFRONT_REGION_ID,
      name: "Storefront",
      currency_code: "ngn",
      // Nigeria VAT (7.5%) expressed in basis points (750 = 7.5%).
      tax_rate: 750,
      // JSONB array columns: pass pre-serialized JSON strings.
      payment_providers: JSON.stringify(["paystack"]),
      fulfillment_providers: JSON.stringify(["shipbubble"]),
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();

  await db
    .insertInto("sales_channel")
    .values({
      id: DEFAULT_STOREFRONT_SALES_CHANNEL_ID,
      name: "Storefront",
      description: "Default storefront sales channel.",
      is_disabled: false,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db
    .deleteFrom("sales_channel")
    .where("id", "=", DEFAULT_STOREFRONT_SALES_CHANNEL_ID)
    .execute();
  await db
    .deleteFrom("region")
    .where("id", "=", DEFAULT_STOREFRONT_REGION_ID)
    .execute();
}