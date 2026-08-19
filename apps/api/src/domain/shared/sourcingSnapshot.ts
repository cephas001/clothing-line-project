// apps/api/src/domain/shared/sourcingSnapshot.ts

// Provider-neutral mapping between the durable inventory reservations and the
// frozen OrderSourcingSnapshot the ORDER records at finalization.
//
// The inventory reservation ledger is the DETERMINISTIC record of which
// (variant, location, quantity) units were reserved for the checkout reference
// at payment initialization. At finalization those rows are confirmed and this
// module freezes them (plus the resolved origin) onto the order so the
// dispatch/RMA flows are self-contained and never depend on the mutable
// inventory tables or a logistics-provider decision. These functions are the
// ONLY writers of the OrderSourcingSnapshot shape and keep the mapper
// provider-neutral (no Shipbubble types here).

import { InventoryLocation } from "@api/domain/entities/InventoryLocation";
import { InventoryReservation } from "@api/domain/entities/InventoryReservation";
import {
  OrderSourcingSnapshot,
  ShipmentOrigin,
} from "@api/domain/shared/contracts";

/**
 * Compose the frozen shipment origin from the location's LOCAL sender record.
 * Returns null when the record is absent or incomplete — the caller then
 * degrades (never invents an origin). `providerAddressCode` is an
 * adapter-owned cache carried through verbatim.
 */
function buildShipmentOrigin(
  location: InventoryLocation,
): ShipmentOrigin | null {
  const sender = location.senderAddress;
  const name = optionalString(sender?.name);
  const email = optionalString(sender?.email);
  const phone = optionalString(sender?.phone);
  const address = optionalString(sender?.address);
  if (!name || !email || !phone || !address) {
    return null;
  }
  return {
    locationId: location.id,
    name,
    email,
    phone,
    address,
    providerAddressCode: location.providerAddressCode ?? null,
  };
}

/**
 * Freeze the order's sourcing snapshot from the confirmed reservation ledger
 * and the resolved locations. `frozenAt` is the order-creation timestamp so
 * the snapshot is anchored to the moment the order became durable.
 *
 * The primary fulfillment location is DETERMINISTIC: the location holding the
 * most quantity, with ties broken by the smallest location id (byte-wise).
 */
export function buildOrderSourcingSnapshot(
  reservations: InventoryReservation[],
  locations: InventoryLocation[],
  frozenAt: string,
): OrderSourcingSnapshot {
  const locationById = new Map<string, InventoryLocation>();
  for (const location of locations) {
    locationById.set(location.id, location);
  }

  const variantLines = reservations
    .map((r) => ({
      variantId: r.variantId,
      quantity: r.quantity,
      locationId: r.locationId,
    }))
    .sort((a, b) =>
      a.variantId < b.variantId
        ? -1
        : a.variantId > b.variantId
          ? 1
          : 0,
    );

  let primaryLocationId: string | null = null;
  if (reservations.length > 0) {
    const quantityByLocation = new Map<string, number>();
    for (const reservation of reservations) {
      quantityByLocation.set(
        reservation.locationId,
        (quantityByLocation.get(reservation.locationId) ?? 0) +
          reservation.quantity,
      );
    }
    let bestQuantity = 0;
    for (const [locationId, quantity] of quantityByLocation) {
      if (
        quantity > bestQuantity ||
        (quantity === bestQuantity &&
          (primaryLocationId === null || locationId < primaryLocationId))
      ) {
        bestQuantity = quantity;
        primaryLocationId = locationId;
      }
    }
  }

  const primaryLocation =
    primaryLocationId !== null ? locationById.get(primaryLocationId) : null;

  return {
    frozenAt,
    variantLines,
    primaryLocationId,
    origin: primaryLocation ? buildShipmentOrigin(primaryLocation) : null,
  };
}

/**
 * Validate/rebuild an OrderSourcingSnapshot read back from the database (an
 * untrusted JSON round-trip). Returns null when the value is absent or
 * structurally invalid so callers can degrade defensively (a legacy or
 * custom-only order simply carries no sourcing snapshot).
 */
export function toOrderSourcingSnapshot(
  value: unknown,
): OrderSourcingSnapshot | null {
  const raw = readRecord(value);
  if (!raw) {
    return null;
  }
  const frozenAt = readStringField(raw, "frozenAt");
  if (!frozenAt) {
    return null;
  }

  const variantLines: OrderSourcingSnapshot["variantLines"] = [];
  if (Array.isArray(raw.variantLines)) {
    for (const rawLine of raw.variantLines) {
      const lineRecord = readRecord(rawLine);
      if (!lineRecord) {
        continue;
      }
      const variantId = readStringField(lineRecord, "variantId")?.trim() ?? "";
      const locationId = readStringField(lineRecord, "locationId")?.trim() ?? "";
      const quantity = readNumberField(lineRecord, "quantity");
      if (
        !variantId ||
        !locationId ||
        quantity === null ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1
      ) {
        continue;
      }
      variantLines.push({ variantId, quantity, locationId });
    }
  }

  const primaryLocationIdRaw = readStringField(raw, "primaryLocationId");
  const primaryLocationId =
    primaryLocationIdRaw && primaryLocationIdRaw.trim().length > 0
      ? primaryLocationIdRaw.trim()
      : null;

  let origin: ShipmentOrigin | null = null;
  const originRecord = readRecord(raw.origin);
  if (originRecord) {
    const locationId = readStringField(originRecord, "locationId")?.trim() ?? "";
    const name = readStringField(originRecord, "name")?.trim() ?? "";
    const email = readStringField(originRecord, "email")?.trim() ?? "";
    const phone = readStringField(originRecord, "phone")?.trim() ?? "";
    const address = readStringField(originRecord, "address")?.trim() ?? "";
    if (locationId && name && email && phone && address) {
      origin = {
        locationId,
        name,
        email,
        phone,
        address,
        providerAddressCode: readStringField(originRecord, "providerAddressCode"),
      };
    }
  }

  return { frozenAt, variantLines, primaryLocationId, origin };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readNumberField(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
