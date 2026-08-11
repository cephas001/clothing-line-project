// apps/api/src/infrastructure/database/repositories/PostgresOrderEditRepository.ts

// Postgres-backed implementation of IOrderEditRepository.
//
// Manages order edit proposals. proposedChanges is stored as a JSONB snapshot
// of the change list; reads parse it back into the domain shape. created_at is
// written explicitly because the domain carries it through the entity.

import { OrderEdit } from "@api/domain/entities/OrderEdit";
import type { IOrderEditRepository } from "@api-domain-interfaces/repositories/IOrderEditRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type OrderEditRow = {
  id: string;
  order_id: string;
  action_type: string;
  reason: string | null;
  proposed_changes: unknown;
  status: string;
  difference_due_minor: number;
  created_by: string | null;
  created_at: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  payment_reference: string | null;
};

function toDomain(row: OrderEditRow): OrderEdit {
  const changes = Array.isArray(row.proposed_changes)
    ? (row.proposed_changes as OrderEdit["proposedChanges"])
    : [];

  return new OrderEdit({
    id: row.id,
    orderId: row.order_id,
    actionType: row.action_type,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    status: row.status,
    differenceDueMinor: row.difference_due_minor,
    proposedChanges: changes,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    paymentReference: row.payment_reference,
  });
}

export class PostgresOrderEditRepository implements IOrderEditRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(orderEditId: string): Promise<OrderEdit | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("order_edit")
        .selectAll()
        .where("id", "=", orderEditId)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(orderEdit: OrderEdit): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("order_edit")
        .values({
          id: orderEdit.id,
          order_id: orderEdit.orderId,
          action_type: orderEdit.actionType,
          reason: orderEdit.reason,
          proposed_changes: JSON.stringify(orderEdit.proposedChanges),
          status: orderEdit.status,
          difference_due_minor: orderEdit.differenceDueMinor,
          created_by: orderEdit.createdBy,
          created_at: orderEdit.createdAt,
          confirmed_by: orderEdit.confirmedBy,
          confirmed_at: orderEdit.confirmedAt,
          payment_reference: orderEdit.paymentReference,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            order_id: orderEdit.orderId,
            action_type: orderEdit.actionType,
            reason: orderEdit.reason,
            proposed_changes: JSON.stringify(orderEdit.proposedChanges),
            status: orderEdit.status,
            difference_due_minor: orderEdit.differenceDueMinor,
            created_by: orderEdit.createdBy,
            created_at: orderEdit.createdAt,
            confirmed_by: orderEdit.confirmedBy,
            confirmed_at: orderEdit.confirmedAt,
            payment_reference: orderEdit.paymentReference,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
