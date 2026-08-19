// apps/api/src/infrastructure/database/repositories/PostgresInventoryLevelRepository.ts
//
// Postgres-backed implementation of IInventoryLevelRepository.
//
// The atomic primitives (reserveAvailable / releaseReserved / confirmReserved)
// are single conditional UPDATEs executed against the row-locked level inside
// the current ITransactionManager unit of work — the FINAL concurrency and
// integrity guard (INV-I1 / INV-I2 / INV-I6 / INV-I7). Postgres serializes
// concurrent transactions on the row; the loser re-evaluates the WHERE against
// the winner's committed counters and updates ZERO rows. The DB CHECKs
// (available >= 0, reserved >= 0) make oversell structurally impossible. Each
// primitive returns true when a row was updated, false otherwise (never a
// negative counter).

import { sql } from "kysely";
import { InventoryLevel } from "@api/domain/entities/InventoryLevel";
import type { IInventoryLevelRepository } from "@api-domain-interfaces/repositories/IInventoryLevelRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

function toDomain(row: {
  id: string;
  variant_id: string;
  location_id: string;
  available_quantity: number;
  reserved_quantity: number;
  version: number;
}): InventoryLevel {
  return new InventoryLevel({
    id: row.id,
    variantId: row.variant_id,
    locationId: row.location_id,
    availableQuantity: row.available_quantity,
    reservedQuantity: row.reserved_quantity,
    version: row.version,
  });
}

export class PostgresInventoryLevelRepository
  implements IInventoryLevelRepository
{
  constructor(private readonly context: TransactionContext) {}

  async findByVariant(variantId: string): Promise<InventoryLevel[]> {
    try {
      const rows = await this.context
        .getDb()
        .selectFrom("inventory_level")
        .selectAll()
        .where("variant_id", "=", variantId)
        .execute();
      return rows.map(toDomain);
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByVariantAndLocation(
    variantId: string,
    locationId: string,
  ): Promise<InventoryLevel | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("inventory_level")
        .selectAll()
        .where("variant_id", "=", variantId)
        .where("location_id", "=", locationId)
        .executeTakeFirst();
      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(level: InventoryLevel): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("inventory_level")
        .values({
          id: level.id,
          variant_id: level.variantId,
          location_id: level.locationId,
          available_quantity: level.availableQuantity,
          reserved_quantity: level.reservedQuantity,
          version: level.version,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            available_quantity: level.availableQuantity,
            reserved_quantity: level.reservedQuantity,
            version: level.version,
            updated_at: sql`now()`,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async reserveAvailable(
    locationId: string,
    variantId: string,
    quantity: number,
  ): Promise<boolean> {
    try {
      const result = await this.context
        .getDb()
        .updateTable("inventory_level")
        .set((eb) => ({
          available_quantity: eb("available_quantity", "-", quantity),
          reserved_quantity: eb("reserved_quantity", "+", quantity),
          version: eb("version", "+", 1),
        }))
        .where("location_id", "=", locationId)
        .where("variant_id", "=", variantId)
        .where("available_quantity", ">=", quantity)
        .returning("id")
        .execute();
      return result.length > 0;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async releaseReserved(
    locationId: string,
    variantId: string,
    quantity: number,
  ): Promise<boolean> {
    try {
      const result = await this.context
        .getDb()
        .updateTable("inventory_level")
        .set((eb) => ({
          available_quantity: eb("available_quantity", "+", quantity),
          reserved_quantity: eb("reserved_quantity", "-", quantity),
          version: eb("version", "+", 1),
        }))
        .where("location_id", "=", locationId)
        .where("variant_id", "=", variantId)
        .where("reserved_quantity", ">=", quantity)
        .returning("id")
        .execute();
      return result.length > 0;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async confirmReserved(
    locationId: string,
    variantId: string,
    quantity: number,
  ): Promise<boolean> {
    try {
      const result = await this.context
        .getDb()
        .updateTable("inventory_level")
        .set((eb) => ({
          reserved_quantity: eb("reserved_quantity", "-", quantity),
          version: eb("version", "+", 1),
        }))
        .where("location_id", "=", locationId)
        .where("variant_id", "=", variantId)
        .where("reserved_quantity", ">=", quantity)
        .returning("id")
        .execute();
      return result.length > 0;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}