// apps/api/src/domain/shared/sourcing.ts
//
// L9 — DETERMINISTIC SINGLE-ORIGIN SOURCING RULE (INV-I8).
//
// Given the same (active locations, per-location levels, requested quantity)
// snapshot, this function ALWAYS returns the same location:
//
//   1. Preferred origin:  `priority` ASC, NULLS LAST (lower = more preferred).
//   2. Sufficient stock:  only locations whose level.canReserve(quantity) pass.
//   3. Tie-breaker:       `code` ASC, then `id` ASC.
//
// It NEVER splits across locations, even when the caller allows split
// shipments, and it ignores customer coordinates entirely — proximity is not a
// deterministic business rule and Shipbubble is never consulted. When no single
// location can fulfill the request the function returns null and the caller
// fails explicitly with INSUFFICIENT_SINGLE_LOCATION_STOCK.
//
// The comparison is byte-wise (locale-independent) so the result is stable
// across runtimes/environments.

import { InventoryLocation } from "@api/domain/entities/InventoryLocation";
import { InventoryLevel } from "@api/domain/entities/InventoryLevel";

export function selectOptimalFulfillmentLocation(
  locations: InventoryLocation[],
  levels: InventoryLevel[],
  quantity: number,
): InventoryLocation | null {
  if (!Number.isInteger(quantity) || quantity < 1) {
    return null;
  }

  const levelByLocationId = new Map<string, InventoryLevel>();
  for (const level of levels) {
    levelByLocationId.set(level.locationId, level);
  }

  const candidates: InventoryLocation[] = [];
  for (const location of locations) {
    if (!location.isFulfillable) {
      continue;
    }
    const level = levelByLocationId.get(location.id);
    if (!level || !level.canReserve(quantity)) {
      continue;
    }
    candidates.push(location);
  }

  candidates.sort((a, b) => {
    const priorityA = a.priority ?? Number.MAX_SAFE_INTEGER;
    const priorityB = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    const codeOrder = compareBytes(a.code, b.code);
    if (codeOrder !== 0) {
      return codeOrder;
    }
    return compareBytes(a.id, b.id);
  });

  return candidates.length > 0 ? candidates[0] : null;
}

function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}