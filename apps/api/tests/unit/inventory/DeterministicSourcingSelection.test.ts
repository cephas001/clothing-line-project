// apps/api/tests/unit/inventory/DeterministicSourcingSelection.test.ts
//
// L9 PART 26 — UNIT MATRIX: the deterministic single-origin sourcing rule
// (INV-I8).
//
// `selectOptimalFulfillmentLocation` is the ONLY place a variant's source node
// is chosen. The rule must be:
//   1. Deterministic — the same (locations, levels, quantity) snapshot ALWAYS
//      returns the same location, regardless of input ordering.
//   2. Single-origin — never splits across nodes, even when combined stock
//      would cover the quantity.
//   3. Prefer the lowest `priority` (nulls last), then `code` ASC, then `id`
//      ASC (byte-wise, locale-independent).
//   4. Only ACTIVE locations with sufficient stock are candidates.
//   5. A non-positive/fractional quantity is not a sourcing decision (null).
//
// No repositories or use cases: this is the pure domain rule at its boundary.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { selectOptimalFulfillmentLocation } from "@api/domain/shared/sourcing";
import { InventoryLocation } from "@api/domain/entities/InventoryLocation";
import { InventoryLevel } from "@api/domain/entities/InventoryLevel";

function loc(
  id: string,
  code: string,
  overrides: Partial<{
    active: boolean;
    priority: number | null;
  }> = {},
): InventoryLocation {
  return new InventoryLocation({
    id,
    code,
    name: `Location ${code}`,
    isActive: overrides.active ?? true,
    priority: overrides.priority ?? null,
    senderAddress: {
      name: `Origin ${code}`,
      email: `${code.toLowerCase()}@origin.test`,
      phone: "+2348000000000",
      address: "1 Origin Road",
    },
  });
}

function level(
  variantId: string,
  locationId: string,
  availableQuantity: number,
): InventoryLevel {
  return new InventoryLevel({
    id: `level-${locationId}-${variantId}`,
    variantId,
    locationId,
    availableQuantity,
  });
}

describe("selectOptimalFulfillmentLocation — deterministic single-origin rule", () => {
  it("picks the lowest-priority sufficient location (lower = more preferred)", () => {
    const locations = [
      loc("loc-b", "B", { priority: 3 }),
      loc("loc-a", "A", { priority: 1 }),
      loc("loc-c", "C", { priority: 2 }),
    ];
    const levels = [
      level("v-1", "loc-a", 10),
      level("v-1", "loc-b", 10),
      level("v-1", "loc-c", 10),
    ];
    const chosen = selectOptimalFulfillmentLocation(locations, levels, 5);
    expect(chosen!.id).toBe("loc-a");
  });

  it("sorts null priority AFTER explicit priorities", () => {
    const locations = [loc("loc-null", "Z", { priority: null }), loc("loc-9", "A")];
    const levels = [
      level("v-1", "loc-null", 10),
      level("v-1", "loc-9", 10),
    ];
    const chosen = selectOptimalFulfillmentLocation(locations, levels, 5);
    expect(chosen!.id).toBe("loc-9");
  });

  it("skips inactive locations entirely", () => {
    const locations = [
      loc("loc-off", "A", { priority: 1, active: false }),
      loc("loc-on", "B", { priority: 5 }),
    ];
    const levels = [
      level("v-1", "loc-off", 10),
      level("v-1", "loc-on", 10),
    ];
    const chosen = selectOptimalFulfillmentLocation(locations, levels, 5);
    expect(chosen!.id).toBe("loc-on");
  });

  it("skips locations whose stock does not cover the quantity", () => {
    const locations = [
      loc("loc-p1", "A", { priority: 1 }),
      loc("loc-p2", "B", { priority: 2 }),
    ];
    const levels = [
      level("v-1", "loc-p1", 3), // insufficient for 5
      level("v-1", "loc-p2", 9),
    ];
    const chosen = selectOptimalFulfillmentLocation(locations, levels, 5);
    expect(chosen!.id).toBe("loc-p2");
  });

  it("breaks equal-priority ties by code ASC, then id ASC", () => {
    const locations = [
      loc("loc-z", "Z"),
      loc("loc-a", "A"),
      loc("loc-m", "M"),
    ];
    const levels = [
      level("v-1", "loc-z", 10),
      level("v-1", "loc-a", 10),
      level("v-1", "loc-m", 10),
    ];
    const chosen = selectOptimalFulfillmentLocation(locations, levels, 5);
    expect(chosen!.id).toBe("loc-a");

    // Same code, distinct ids -> id ASC wins.
    const sameCode = [
      loc("loc-2", "SAME"),
      loc("loc-1", "SAME"),
    ];
    const sameLevels = [
      level("v-1", "loc-2", 10),
      level("v-1", "loc-1", 10),
    ];
    const idChosen = selectOptimalFulfillmentLocation(
      sameCode,
      sameLevels,
      5,
    );
    expect(idChosen!.id).toBe("loc-1");
  });

  it("is byte-stable regardless of the input ordering", () => {
    const locations = [
      loc("loc-a", "A"),
      loc("loc-b", "B"),
      loc("loc-c", "C"),
    ];
    const levels = [
      level("v-1", "loc-a", 10),
      level("v-1", "loc-b", 10),
      level("v-1", "loc-c", 10),
    ];
    const forwards = selectOptimalFulfillmentLocation(locations, levels, 5);
    const backwards = selectOptimalFulfillmentLocation(
      [...locations].reverse(),
      [...levels].reverse(),
      5,
    );
    const shuffled = selectOptimalFulfillmentLocation(
      [locations[2], locations[0], locations[1]],
      [levels[1], levels[2], levels[0]],
      5,
    );
    expect(forwards!.id).toBe(backwards!.id);
    expect(forwards!.id).toBe(shuffled!.id);
  });

  it("never splits across locations — returns null when no single node suffices", () => {
    const locations = [loc("loc-a", "A"), loc("loc-b", "B")];
    const levels = [
      level("v-1", "loc-a", 3), // combined 6 >= 5 but neither covers 5 alone
      level("v-1", "loc-b", 3),
    ];
    const chosen = selectOptimalFulfillmentLocation(locations, levels, 5);
    expect(chosen).toBeNull();
  });

  it("returns null for a missing level even when the location exists", () => {
    const locations = [loc("loc-a", "A")];
    const chosen = selectOptimalFulfillmentLocation(locations, [], 1);
    expect(chosen).toBeNull();
  });

  it("returns null for non-positive or fractional quantities", () => {
    const locations = [loc("loc-a", "A")];
    const levels = [level("v-1", "loc-a", 10)];
    expect(selectOptimalFulfillmentLocation(locations, levels, 0)).toBeNull();
    expect(selectOptimalFulfillmentLocation(locations, levels, -1)).toBeNull();
    expect(selectOptimalFulfillmentLocation(locations, levels, 1.5)).toBeNull();
  });
});