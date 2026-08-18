// apps/api/src/infrastructure/database/repositories/PostgresInventoryReservationRepository.ts
//
// Postgres-backed implementation of IInventoryReservationRepository.
//
// Persists the durable reservation ledger (`inventory_reservation`). The
// DETERMINISTIC `reservation_key` is UNIQUE, so a retried/concurrent duplicate
// collides and rolls back the whole unit of work instead of double-reserving
// (INV-I3 / INV-I4). `save` upserts on `id` (replay/reactivate updates the SAME
// row); `createIfAbsent` inserts a NEW row ONLY when its key does not exist —
// returning false tells the caller a concurrent winner already committed and
// its own unit must roll back (decrement undone).

import { sql } from "kysely";
import {
  InventoryReservation,
  InventoryReservationStatus,
} from "@api/domain/entities/InventoryReservation";
import type { IInventoryReservationRepository } from "@api-domain-interfaces/repositories/IInventoryReservationRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

function toDomain(row: {
  id: string;
  reservation_key: string;
  location_id: string;
  variant_id: string;
  quantity: number;
  status: string;
  order_id: string | null;
  expires_at: string | null;
  version: number;
}): InventoryReservation {
  return new InventoryReservation({
    id: row.id,
    reservationKey: row.reservation_key,
    locationId: row.location_id,
    variantId: row.variant_id,
    quantity: row.quantity,
    status: row.status as InventoryReservationStatus,
    orderId: row.order_id,
    expiresAt: row.expires_at,
    version: row.version,
  });
}

export class PostgresInventoryReservationRepository
  implements IInventoryReservationRepository
{
  constructor(private readonly context: TransactionContext) {}

  async findByKey(reservationKey: string): Promise<InventoryReservation | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("inventory_reservation")
        .selectAll()
        .where("reservation_key", "=", reservationKey)
        .executeTakeFirst();
      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByOrder(orderId: string): Promise<InventoryReservation[]> {
    try {
      const rows = await this.context
        .getDb()
        .selectFrom("inventory_reservation")
        .selectAll()
        .where("order_id", "=", orderId)
        .orderBy("variant_id", "asc")
        .orderBy("id", "asc")
        .execute();
      return rows.map(toDomain);
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(reservation: InventoryReservation): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("inventory_reservation")
        .values({
          id: reservation.id,
          reservation_key: reservation.reservationKey,
          location_id: reservation.locationId,
          variant_id: reservation.variantId,
          quantity: reservation.quantity,
          status: reservation.status,
          order_id: reservation.orderId,
          expires_at: reservation.expiresAt,
          version: reservation.version,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            reservation_key: reservation.reservationKey,
            location_id: reservation.locationId,
            variant_id: reservation.variantId,
            quantity: reservation.quantity,
            status: reservation.status,
            order_id: reservation.orderId,
            expires_at: reservation.expiresAt,
            version: reservation.version,
            updated_at: sql`now()`,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async createIfAbsent(reservation: InventoryReservation): Promise<boolean> {
    try {
      const result = await this.context
        .getDb()
        .insertInto("inventory_reservation")
        .values({
          id: reservation.id,
          reservation_key: reservation.reservationKey,
          location_id: reservation.locationId,
          variant_id: reservation.variantId,
          quantity: reservation.quantity,
          status: reservation.status,
          order_id: reservation.orderId,
          expires_at: reservation.expiresAt,
          version: reservation.version,
        })
        .onConflict((oc) => oc.column("reservation_key").doNothing())
        .returning("id")
        .execute();
      return result.length > 0;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}