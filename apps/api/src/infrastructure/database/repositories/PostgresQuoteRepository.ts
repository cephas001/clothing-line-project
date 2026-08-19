// apps/api/src/infrastructure/database/repositories/PostgresQuoteRepository.ts

// Postgres-backed implementation of IQuoteRepository.
//
// Manages B2B quotes. The cart snapshot is stored as a text JSON string
// (already serialized by RequestQuoteUseCase); approval fields are nullable
// until the quote is approved. requested_at is written explicitly because the
// entity carries it.

import { Quote } from "@api/domain/entities/Quote";
import type { IQuoteRepository } from "@api-domain-interfaces/repositories/IQuoteRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type QuoteRow = {
  id: string;
  cart_id: string;
  cart_snapshot_json: string;
  business_unit_id: string;
  requested_by_customer_id: string;
  requested_at: string;
  status: Quote["status"];
  notes: string | null;
  approved_total_minor: number | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_note: string | null;
};

function toDomain(row: QuoteRow): Quote {
  return new Quote({
    id: row.id,
    cartId: row.cart_id,
    cartSnapshotJson: row.cart_snapshot_json,
    businessUnitId: row.business_unit_id,
    requestedByCustomerId: row.requested_by_customer_id,
    requestedAt: row.requested_at,
    status: row.status,
    notes: row.notes,
    approvedTotalMinor: row.approved_total_minor,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    approvalNote: row.approval_note,
  });
}

export class PostgresQuoteRepository implements IQuoteRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(quoteId: string): Promise<Quote | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("quote")
        .selectAll()
        .where("id", "=", quoteId)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(quote: Quote): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("quote")
        .values({
          id: quote.id,
          cart_id: quote.cartId,
          cart_snapshot_json: quote.cartSnapshotJson,
          business_unit_id: quote.businessUnitId,
          requested_by_customer_id: quote.requestedByCustomerId,
          requested_at: quote.requestedAt,
          status: quote.status,
          notes: quote.notes,
          approved_total_minor: quote.approvedTotalMinor,
          approved_by: quote.approvedBy,
          approved_at: quote.approvedAt,
          approval_note: quote.approvalNote,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            cart_id: quote.cartId,
            cart_snapshot_json: quote.cartSnapshotJson,
            business_unit_id: quote.businessUnitId,
            requested_by_customer_id: quote.requestedByCustomerId,
            requested_at: quote.requestedAt,
            status: quote.status,
            notes: quote.notes,
            approved_total_minor: quote.approvedTotalMinor,
            approved_by: quote.approvedBy,
            approved_at: quote.approvedAt,
            approval_note: quote.approvalNote,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
