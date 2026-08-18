// apps/api/src/domain/entities/InventoryLocation.ts
//
// L9 — authoritative fulfillment/sourcing node.
//
// A location is the LOCAL source of truth for a shipment origin (Shipbubble
// NEVER becomes the source of truth); `providerAddressCode` is an adapter-owned
// cache of the provider's validated sender code, never a business input.
// `priority` (nullable integer, LOWER = MORE PREFERRED) is the first key of the
// deterministic single-origin sourcing rule (INV-I8): a location only becomes a
// sourcing candidate while it is active (`isActive`).

import { DomainError } from "@api/domain/entities/errors/DomainError";

/** Verified sender/origin record stored on the location (JSONB in the DB). */
export interface InventoryLocationSenderAddress {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
}

export interface InventoryLocationProps {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  priority: number | null;
  senderAddress?: InventoryLocationSenderAddress | null;
  providerAddressCode?: string | null;
}

export class InventoryLocation {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly priority: number | null;
  readonly senderAddress: InventoryLocationSenderAddress | null;
  readonly providerAddressCode: string | null;

  constructor(props: InventoryLocationProps) {
    const id = (props.id ?? "").trim();
    const code = (props.code ?? "").trim().toUpperCase();
    const name = (props.name ?? "").trim();
    const priority = props.priority ?? null;

    if (!id) {
      throw new DomainError("VALIDATION_ERROR", "Location id is required.");
    }
    if (!code) {
      throw new DomainError("VALIDATION_ERROR", "Location code is required.");
    }
    if (!name) {
      throw new DomainError("VALIDATION_ERROR", "Location name is required.");
    }
    if (
      priority !== null &&
      (!Number.isInteger(priority) || priority < 0)
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Location priority must be a non-negative integer or null.",
      );
    }

    this.id = id;
    this.code = code;
    this.name = name;
    this.isActive = Boolean(props.isActive);
    this.priority = priority;
    this.senderAddress = props.senderAddress ?? null;
    this.providerAddressCode = props.providerAddressCode ?? null;
  }

  /** A location is a sourcing candidate only while active (INV-I8). */
  get isFulfillable(): boolean {
    return this.isActive;
  }
}