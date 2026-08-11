// apps/api/src/infrastructure/database/repositories/PostgresDraftOrderRepository.ts

// Postgres-backed implementation of IDraftOrderRepository.
//
// Persists DraftOrderRecord values: line items and metadata are stored as JSONB
// snapshots, shipping_address as JSONB (or null). created_at is a DB default;
// reads carry the DB-generated value back into the record.

import type {
  DraftOrderItem,
  DraftOrderRecord,
} from "@api/domain/shared/contracts";
import type { IDraftOrderRepository } from "@api-domain-interfaces/repositories/IDraftOrderRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type DraftOrderRow = {
  id: string;
  email: string;
  items: unknown;
  shipping_address: unknown;
  total_minor: number;
  status: string;
  created_by: string;
  created_at: string;
  metadata: unknown;
};

function toDomain(row: DraftOrderRow): DraftOrderRecord {
  const metadata =
    row.metadata && typeof row.metadata === "object"
      ? (row.metadata as { createdByActor: string })
      : { createdByActor: row.created_by };

  return {
    id: row.id,
    email: row.email,
    items: Array.isArray(row.items) ? (row.items as DraftOrderItem[]) : [],
    shippingAddress:
      row.shipping_address && typeof row.shipping_address === "object"
        ? (row.shipping_address as Record<string, unknown>)
        : null,
    totalMinor: row.total_minor,
    status: row.status as DraftOrderRecord["status"],
    createdBy: row.created_by,
    createdAt: row.created_at,
    metadata,
  };
}

export class PostgresDraftOrderRepository implements IDraftOrderRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(draftOrderId: string): Promise<DraftOrderRecord | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("draft_order")
        .selectAll()
        .where("id", "=", draftOrderId)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(draftOrder: DraftOrderRecord): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("draft_order")
        .values({
          id: draftOrder.id,
          email: draftOrder.email,
          items: JSON.stringify(draftOrder.items),
          shipping_address: draftOrder.shippingAddress
            ? JSON.stringify(draftOrder.shippingAddress)
            : null,
          total_minor: draftOrder.totalMinor,
          status: draftOrder.status,
          created_by: draftOrder.createdBy,
          created_at: draftOrder.createdAt,
          metadata: JSON.stringify(draftOrder.metadata),
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            email: draftOrder.email,
            items: JSON.stringify(draftOrder.items),
            shipping_address: draftOrder.shippingAddress
              ? JSON.stringify(draftOrder.shippingAddress)
              : null,
            total_minor: draftOrder.totalMinor,
            status: draftOrder.status,
            created_by: draftOrder.createdBy,
            created_at: draftOrder.createdAt,
            metadata: JSON.stringify(draftOrder.metadata),
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
