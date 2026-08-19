// apps/api/tests/db/ConstraintEnforcement.test.ts
//
// REAL-POSTGRES CONSTRAINT TESTS — L6 item 28.
//
// These tests run against a freshly migrated `commerce_db_test` database and
// assert the DDL itself is the final concurrency/idempotency guard. They do
// NOT use the in-memory fakes: every assertion drives the real Postgres
// server and expects the real unique_violation (SQLSTATE 23505) from the
// engine.
//
//   - payment.reference / provider_reference UNIQUE.
//   - partial UNIQUE(obligation_type, obligation_id) WHERE status <> 'failed'
//     (payment_obligation_active_unique): one ACTIVE obligation per business
//     object; a fresh row is legal only after the prior obligation is `failed`.
//   - refund idempotency UNIQUEs (refund_reference;
//     provider_transaction_reference + amount_minor).
//   - fulfillment dispatch-claim partial UNIQUE (fulfillment_dispatch_claim_unique):
//     at most one dispatch_pending/dispatched/pending_dispatch row per order;
//     terminal rows (failed) never block a fresh claim.
//   - cart.version optimistic-lock column (defaults to 0).

import { sql } from "kysely";
import type { RawBuilder } from "kysely";
import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { getDbHarness } from "./dbHarness";

function q(raw: string): RawBuilder<unknown> {
  return sql.raw(raw);
}

async function isUniqueViolation(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (err: unknown) {
    return (err as { code?: string }).code === "23505";
  }
}

describe("Real Postgres — payment idempotency constraints", () => {
  it("UNIQUE(reference) rejects a duplicate app idempotency key", async () => {
    const h = getDbHarness();
    await q(
      "INSERT INTO payment (id, obligation_type, obligation_id, reference, amount_minor, status) VALUES ('p-1', 'checkout', 'cart-1', 'CLP-checkout-cart-1', 61000, 'initialized')",
    ).execute(h.db);
    const violated = await isUniqueViolation(() =>
      q(
        "INSERT INTO payment (id, obligation_type, obligation_id, reference, amount_minor, status) VALUES ('p-2', 'checkout', 'cart-2', 'CLP-checkout-cart-1', 50000, 'initialized')",
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });

  it("UNIQUE(provider_reference) rejects a duplicate provider transaction", async () => {
    const h = getDbHarness();
    await q(
      "INSERT INTO payment (id, obligation_type, obligation_id, reference, amount_minor, status) VALUES ('p-10', 'checkout', 'cart-10', 'CLP-checkout-cart-10', 61000, 'initialized')",
    ).execute(h.db);
    await q(
      "UPDATE payment SET provider_reference = 'pay-ref-10' WHERE id = 'p-10'",
    ).execute(h.db);
    await q(
      "INSERT INTO payment (id, obligation_type, obligation_id, reference, amount_minor, status) VALUES ('p-11', 'checkout', 'cart-11', 'CLP-checkout-cart-11', 61000, 'initialized')",
    ).execute(h.db);
    const violated = await isUniqueViolation(() =>
      q(
        "UPDATE payment SET provider_reference = 'pay-ref-10' WHERE id = 'p-11'",
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });

  it("the ACTIVE-obligation partial unique forbids a second ACTIVE obligation per cart", async () => {
    const h = getDbHarness();
    await q(
      "INSERT INTO payment (id, obligation_type, obligation_id, reference, amount_minor, status) VALUES ('p-20', 'checkout', 'cart-20', 'CLP-checkout-cart-20', 61000, 'initialized')",
    ).execute(h.db);
    const violated = await isUniqueViolation(() =>
      q(
        "INSERT INTO payment (id, obligation_type, obligation_id, reference, amount_minor, status) VALUES ('p-21', 'checkout', 'cart-20', 'CLP-checkout-cart-20-A1', 61000, 'initialization_pending')",
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });

  it("a fresh obligation is legal only AFTER the prior one is `failed`", async () => {
    const h = getDbHarness();
    await q(
      "INSERT INTO payment (id, obligation_type, obligation_id, reference, amount_minor, status) VALUES ('p-30', 'checkout', 'cart-30', 'CLP-checkout-cart-30', 61000, 'initialized')",
    ).execute(h.db);
    await q(
      "UPDATE payment SET status = 'failed' WHERE id = 'p-30'",
    ).execute(h.db);
    await q(
      "INSERT INTO payment (id, obligation_type, obligation_id, reference, amount_minor, status) VALUES ('p-31', 'checkout', 'cart-30', 'CLP-checkout-cart-30-A1', 61000, 'initialization_pending')",
    ).execute(h.db);
    const count = await sql<{ n: string }>`
      SELECT count(*)::int AS n FROM payment
      WHERE obligation_type = 'checkout' AND obligation_id = 'cart-30'
    `.execute(h.db);
    expect(Number(count.rows[0].n)).toBe(2);
  });

  it("settled obligations still collide (no second obligation on settled money)", async () => {
    const h = getDbHarness();
    await q(
      "INSERT INTO payment (id, obligation_type, obligation_id, reference, amount_minor, status) VALUES ('p-40', 'checkout', 'cart-40', 'CLP-checkout-cart-40', 61000, 'captured')",
    ).execute(h.db);
    const violated = await isUniqueViolation(() =>
      q(
        "INSERT INTO payment (id, obligation_type, obligation_id, reference, amount_minor, status) VALUES ('p-41', 'checkout', 'cart-40', 'CLP-checkout-cart-40-A1', 61000, 'initialization_pending')",
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });
});

describe("Real Postgres — refund idempotency constraints", () => {
  it("UNIQUE(refund_reference) rejects a duplicate refund", async () => {
    const h = getDbHarness();
    const cols =
      "(id, refund_reference, provider_transaction_reference, amount_minor)";
    await q(
      `INSERT INTO refund ${cols} VALUES ('r-1', 'refund-1', 'tx-1', 5000)`,
    ).execute(h.db);
    const violated = await isUniqueViolation(() =>
      q(
        `INSERT INTO refund ${cols} VALUES ('r-2', 'refund-1', 'tx-2', 5000)`,
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });

  it("(provider_transaction_reference, amount_minor) UNIQUE rejects the same refund twice", async () => {
    const h = getDbHarness();
    const cols =
      "(id, refund_reference, provider_transaction_reference, amount_minor)";
    await q(
      `INSERT INTO refund ${cols} VALUES ('r-10', 'refund-10', 'tx-10', 5000)`,
    ).execute(h.db);
    const violated = await isUniqueViolation(() =>
      q(
        `INSERT INTO refund ${cols} VALUES ('r-11', 'refund-11', 'tx-10', 5000)`,
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });

  it("a different amount for the same transaction reference is allowed (idempotency is exact)", async () => {
    const h = getDbHarness();
    const cols =
      "(id, refund_reference, provider_transaction_reference, amount_minor)";
    await q(
      `INSERT INTO refund ${cols} VALUES ('r-20', 'refund-20', 'tx-20', 5000)`,
    ).execute(h.db);
    await q(
      `INSERT INTO refund ${cols} VALUES ('r-21', 'refund-21', 'tx-20', 6000)`,
    ).execute(h.db);
    const count = await sql<{ n: string }>`
      SELECT count(*)::int AS n FROM refund
      WHERE provider_transaction_reference = 'tx-20'
    `.execute(h.db);
    expect(Number(count.rows[0].n)).toBe(2);
  });
});

describe("Real Postgres — fulfillment dispatch-claim constraint", () => {
  async function seedOrderChain(orderId: string): Promise<void> {
    const h = getDbHarness();
    await q(
      "INSERT INTO region (id, name, currency_code, tax_rate) VALUES ('region-db', 'Test', 'NGN', 750) ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    await q(
      "INSERT INTO sales_channel (id, name) VALUES ('channel-db', 'DB') ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    await q(
      "INSERT INTO customer (id, first_name, last_name, email) VALUES ('customer-db', 'Ada', 'Okafor', 'ada-db@example.com') ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    await q(
      `INSERT INTO cart (id, region_id, sales_channel_id, customer_id) VALUES ('cart-${orderId}', 'region-db', 'channel-db', 'customer-db') ON CONFLICT (id) DO NOTHING`,
    ).execute(h.db);
    await q(
      `INSERT INTO "order" (id, cart_id, customer_id, total_minor) VALUES ('${orderId}', 'cart-${orderId}', 'customer-db', 61000) ON CONFLICT (id) DO NOTHING`,
    ).execute(h.db);
  }

  it("permits exactly ONE dispatch claim (dispatch_pending/dispatched) per order", async () => {
    const h = getDbHarness();
    const orderId = "order-claim-1";
    await seedOrderChain(orderId);

    const cols = "(id, order_id, tracking_number, status)";
    await q(
      `INSERT INTO fulfillment ${cols} VALUES ('f-1', '${orderId}', 'SB-1', 'dispatch_pending')`,
    ).execute(h.db);
    const violated = await isUniqueViolation(() =>
      q(
        `INSERT INTO fulfillment ${cols} VALUES ('f-2', '${orderId}', 'SB-2', 'dispatched')`,
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });

  it("a TERMINAL (failed) fulfillment never blocks a fresh dispatch claim", async () => {
    const h = getDbHarness();
    const orderId = "order-claim-2";
    await seedOrderChain(orderId);

    const cols = "(id, order_id, tracking_number, status)";
    await q(
      `INSERT INTO fulfillment ${cols} VALUES ('f-10', '${orderId}', 'SB-10', 'failed')`,
    ).execute(h.db);
    await q(
      `INSERT INTO fulfillment ${cols} VALUES ('f-11', '${orderId}', 'SB-11', 'dispatch_pending')`,
    ).execute(h.db);
    const count = await sql<{ n: string }>`
      SELECT count(*)::int AS n FROM fulfillment
      WHERE order_id = ${orderId}
    `.execute(h.db);
    expect(Number(count.rows[0].n)).toBe(2);
  });
});

describe("Real Postgres — cart optimistic-lock column", () => {
  it("cart.version exists, is NOT NULL, and defaults to 0", async () => {
    const h = getDbHarness();
    await q(
      "INSERT INTO region (id, name, currency_code, tax_rate) VALUES ('region-v', 'Test', 'NGN', 750) ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    await q(
      "INSERT INTO sales_channel (id, name) VALUES ('channel-v', 'DB') ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    await q(
      "INSERT INTO cart (id, region_id, sales_channel_id) VALUES ('cart-v', 'region-v', 'channel-v')",
    ).execute(h.db);
    const row = await sql<{ version: number }>`
      SELECT version FROM cart WHERE id = 'cart-v'
    `.execute(h.db);
    expect(row.rows[0].version).toBe(0);

    const column = await sql<{ is_nullable: string }>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'cart' AND column_name = 'version'
    `.execute(h.db);
    expect(column.rows[0].is_nullable).toBe("NO");
  });
});