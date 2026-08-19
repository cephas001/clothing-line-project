// apps/api/src/infrastructure/database/migrations/0009_cart_shipping_quote_selection.ts
//
// Gives the cart the durable, server-validated shipping SELECTION state:
//   - cart.shipping_quotes (jsonb)   — the provider rate response the client
//     chose from (includes the provider selection fields courierId/serviceCode/
//     requestToken; NEVER exposed to the client). Selection resolves against
//     this list so the authoritative amount and currency ALWAYS come from a
//     server-validated quote, never from the client.
//   - cart.shipping_quote_id (text)  — the application id of the SELECTED quote.
//   - cart.shipping_currency (text)  — the ISO-4217 currency of the selected
//     quote.
//   - cart.shipping_quote_fingerprint (text) — canonical fingerprint of the
//     cart's material quote inputs at rate-retrieval time. A selection (and the
//     authoritative checkout calculation) is valid ONLY while the current cart
//     computes the same fingerprint, so a mutated cart can never select or
//     charge a quote obtained for a different cart state.
//
// This completes the cart shipping invariant ("no shipping selected" = all null
// vs "shipping selected" = a complete set) and makes the checkout total and the
// two-phase label flow depend on durable server state only.
//
// Down reverses all additions. Existing migration history is untouched.

import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("cart")
    .addColumn("shipping_quote_id", "text")
    .addColumn("shipping_currency", "text")
    .addColumn("shipping_quotes", "jsonb")
    .addColumn("shipping_quote_fingerprint", "text")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("cart")
    .dropColumn("shipping_quote_fingerprint")
    .dropColumn("shipping_quotes")
    .dropColumn("shipping_currency")
    .dropColumn("shipping_quote_id")
    .execute();
}