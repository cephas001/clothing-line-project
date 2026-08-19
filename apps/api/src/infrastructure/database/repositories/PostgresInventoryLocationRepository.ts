// apps/api/src/infrastructure/database/repositories/PostgresInventoryLocationRepository.ts
//
// Postgres-backed implementation of IInventoryLocationRepository.
//
// Persists the authoritative fulfillment/sourcing node registry
// (`inventory_location`). The LOCAL sender/origin record is the source of
// truth for a node's shipment origin (Shipbubble NEVER becomes the source of
// truth); `provider_address_code` is an adapter-owned cache. `save` is an
// upsert on `id` and regenerates `updated_at` on every write.

import { sql } from "kysely";
import {
  InventoryLocation,
  InventoryLocationSenderAddress,
} from "@api/domain/entities/InventoryLocation";
import type { IInventoryLocationRepository } from "@api-domain-interfaces/repositories/IInventoryLocationRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

function toDomain(row: {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
  priority: number | null;
  sender_address: unknown;
  provider_address_code: string | null;
}): InventoryLocation {
  return new InventoryLocation({
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.is_active,
    priority: row.priority ?? null,
    senderAddress:
      (row.sender_address as unknown as InventoryLocationSenderAddress | null) ??
      null,
    providerAddressCode: row.provider_address_code ?? null,
  });
}

export class PostgresInventoryLocationRepository
  implements IInventoryLocationRepository
{
  constructor(private readonly context: TransactionContext) {}

  async findById(id: string): Promise<InventoryLocation | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("inventory_location")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByCode(code: string): Promise<InventoryLocation | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("inventory_location")
        .selectAll()
        .where("code", "=", code.trim().toUpperCase())
        .executeTakeFirst();
      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async listActive(): Promise<InventoryLocation[]> {
    try {
      const rows = await this.context
        .getDb()
        .selectFrom("inventory_location")
        .selectAll()
        .where("is_active", "=", true)
        .orderBy("code", "asc")
        .execute();
      return rows.map(toDomain);
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(location: InventoryLocation): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("inventory_location")
        .values({
          id: location.id,
          code: location.code,
          name: location.name,
          is_active: location.isActive,
          priority: location.priority,
          sender_address: JSON.stringify(location.senderAddress ?? {}),
          provider_address_code: location.providerAddressCode,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            code: location.code,
            name: location.name,
            is_active: location.isActive,
            priority: location.priority,
            sender_address: JSON.stringify(location.senderAddress ?? {}),
            provider_address_code: location.providerAddressCode,
            updated_at: sql`now()`,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}