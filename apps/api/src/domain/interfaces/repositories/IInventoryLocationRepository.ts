// apps/api/src/domain/interfaces/repositories/IInventoryLocationRepository.ts
//
// L9 — persistence contract for the authoritative fulfillment/sourcing node
// registry (`inventory_location`). The LOCAL record is the source of truth for
// a node's shipment origin; Shipbubble is never consulted here.

import { InventoryLocation } from "@api/domain/entities/InventoryLocation";

export interface IInventoryLocationRepository {
  findById(id: string): Promise<InventoryLocation | null>;
  findByCode(code: string): Promise<InventoryLocation | null>;
  /** All active nodes (INV-I8 sourcing candidates). Ordered by code for stable reads. */
  listActive(): Promise<InventoryLocation[]>;
  save(location: InventoryLocation): Promise<void>;
}