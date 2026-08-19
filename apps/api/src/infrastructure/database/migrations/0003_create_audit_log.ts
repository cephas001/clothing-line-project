// apps/api/src/infrastructure/database/migrations/0003_create_audit_log.ts
//
// Cross-cutting audit trail persisted by PostgresAuditLogService
// (infrastructure/services/PostgresAuditLogService.ts) on behalf of
// IAuditLogService.logAction. Columns mirror `../schema/types.ts` exactly.
//
// Conventions:
//   - `id` (text UUID) is application-generated via IIdGenerator and always
//     supplied on insert, so it is a plain text primary key.
//   - `actor_id` is non-null: the domain contract (`adminId: string`) always
//     passes a normalized non-empty actor string ("system" when none is given).
//   - `details` is JSONB and defaults to an empty object, matching the other
//     required JSONB columns (metadata, roles, items, ...).
//   - `created_at` uses the SQL default `now()`.
//
// Down migration drops the table.

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("audit_log")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("actor_id", "text", (col) => col.notNull())
    .addColumn("action", "text", (col) => col.notNull())
    .addColumn("details", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("audit_log").execute();
}
