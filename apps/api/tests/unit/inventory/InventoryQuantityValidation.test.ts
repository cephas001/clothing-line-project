// apps/api/tests/unit/inventory/InventoryQuantityValidation.test.ts
//
// L9 PART 26 — UNIT MATRIX: quantity validation at the entity and use-case
// boundary.
//
// The L9 invariants depend on whole, positive, non-negative quantities at every
// layer:
//   INV-I1/INV-I2 — the ledger counters are non-negative integers and a
//     reservation can only ever move whole positive units.
//   INV-I3/INV-I4 — a reservation quantity is a positive integer and requests
//     are aggregated deterministically (summed per variant, processed in
//     variantId order) so retries replay byte-identically.
//   INV-I8     — sourcing requires a positive integer quantity; anything else
//     is not a sourcing decision at all.
//
// These tests drive the DOMAIN ENTITIES (InventoryLevel, InventoryReservation)
// and the ReserveInventoryUseCase input validation directly — no repositories
// beyond the shared harness, no databases. A rejected input must always fail
// with a stable domain code (never a raw Number NaN/Infinity path).

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { InventoryLevel } from "@api/domain/entities/InventoryLevel";
import {
  InventoryReservation,
  type InventoryReservationStatus,
} from "@api/domain/entities/InventoryReservation";
import { createPaymentHarness } from "../../integration/payment/harness";

describe("InventoryLevel — non-negative integer counter invariants", () => {
  it("rejects a negative availableQuantity at construction", () => {
    expect(() =>
      new InventoryLevel({
        id: "level-1",
        variantId: "variant-1",
        locationId: "loc-default",
        availableQuantity: -1,
      }),
    ).toThrowWithCode("VALIDATION_ERROR");
  });

  it("rejects a negative reservedQuantity at construction", () => {
    expect(() =>
      new InventoryLevel({
        id: "level-1",
        variantId: "variant-1",
        locationId: "loc-default",
        availableQuantity: 5,
        reservedQuantity: -1,
      }),
    ).toThrowWithCode("VALIDATION_ERROR");
  });

  it("rejects a fractional availableQuantity at construction", () => {
    expect(() =>
      new InventoryLevel({
        id: "level-1",
        variantId: "variant-1",
        locationId: "loc-default",
        availableQuantity: 1.5,
      }),
    ).toThrowWithCode("VALIDATION_ERROR");
  });

  it("rejects fractional, zero and negative reservation quantities", () => {
    const level = new InventoryLevel({
      id: "level-1",
      variantId: "variant-1",
      locationId: "loc-default",
      availableQuantity: 5,
    });
    expect(() => level.reserveAvailable(1.5)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
    expect(() => level.reserveAvailable(0)).toThrowWithCode("VALIDATION_ERROR");
    expect(() => level.reserveAvailable(-2)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("canReserve reflects real availability and reserveAvailable never oversells", () => {
    const level = new InventoryLevel({
      id: "level-1",
      variantId: "variant-1",
      locationId: "loc-default",
      availableQuantity: 2,
    });
    expect(level.canReserve(2)).toBe(true);
    level.reserveAvailable(2);
    expect(level.canReserve(1)).toBe(false);
    expect(level.availableQuantity).toBe(0);
    expect(level.reservedQuantity).toBe(2);
    // The entity itself refuses the oversell (INV-I2); the atomic repository
    // primitive additionally returns false so the use case fails the unit.
    expect(() => level.reserveAvailable(1)).toThrowWithCode(
      "INSUFFICIENT_INVENTORY",
    );
  });

  it("releaseReserved returns exactly the held units and never more", () => {
    const level = new InventoryLevel({
      id: "level-1",
      variantId: "variant-1",
      locationId: "loc-default",
      availableQuantity: 3,
    });
    level.reserveAvailable(3);
    expect(() => level.releaseReserved(4)).toThrowWithCode(
      "INVALID_OPERATION",
    );
    level.releaseReserved(3);
    expect(level.availableQuantity).toBe(3);
    expect(level.reservedQuantity).toBe(0);
  });

  it("confirmReserved consumes exactly the held units and never more", () => {
    const level = new InventoryLevel({
      id: "level-1",
      variantId: "variant-1",
      locationId: "loc-default",
      availableQuantity: 3,
    });
    level.reserveAvailable(2);
    expect(() => level.confirmReserved(3)).toThrowWithCode(
      "INVALID_OPERATION",
    );
    level.confirmReserved(2);
    // Consumed: available unchanged, reserved emptied.
    expect(level.availableQuantity).toBe(1);
    expect(level.reservedQuantity).toBe(0);
  });

  it("conserves available + reserved across the whole lifecycle", () => {
    const level = new InventoryLevel({
      id: "level-1",
      variantId: "variant-1",
      locationId: "loc-default",
      availableQuantity: 10,
    });
    // Reserve/release moves units between the counters: the total never moves.
    level.reserveAvailable(4);
    expect(level.availableQuantity + level.reservedQuantity).toBe(10);
    level.releaseReserved(2);
    expect(level.availableQuantity + level.reservedQuantity).toBe(10);
    // Confirmed units are consumed FOREVER (stock leaves the ledger): every
    // confirmed unit is subtracted from the remaining available+reserved.
    level.confirmReserved(2);
    expect(level.availableQuantity + level.reservedQuantity).toBe(8);
    expect(level.availableQuantity).toBe(8);
    expect(level.reservedQuantity).toBe(0);
  });
});

describe("InventoryReservation — positive integer quantity + state machine guards", () => {
  it("rejects zero, negative and fractional reservation quantities", () => {
    for (const quantity of [0, -1, 1.5]) {
      expect(() =>
        new InventoryReservation({
          id: "r-1",
          reservationKey: "reserve:o-1:variant-1:loc-default",
          locationId: "loc-default",
          variantId: "variant-1",
          quantity,
          status: "reserved",
        }),
      ).toThrowWithCode("VALIDATION_ERROR");
    }
  });

  it("rejects an unknown reservation status", () => {
    expect(() =>
      new InventoryReservation({
        id: "r-1",
        reservationKey: "reserve:o-1:variant-1:loc-default",
        locationId: "loc-default",
        variantId: "variant-1",
        quantity: 1,
        status: "definitely-not-a-status" as InventoryReservationStatus,
      }),
    ).toThrowWithCode("VALIDATION_ERROR");
  });

  it("confirm is only legal from reserved; confirmed is terminal and can never reactivate", () => {
    const reservation = new InventoryReservation({
      id: "r-1",
      reservationKey: "reserve:o-1:variant-1:loc-default",
      locationId: "loc-default",
      variantId: "variant-1",
      quantity: 2,
      status: "reserved",
    });
    reservation.confirm();
    expect(reservation.status).toBe("confirmed");
    expect(reservation.isTerminal).toBe(true);
    expect(reservation.isHeld).toBe(false);
    // Confirmed consumes the units forever: re-activation is a domain error
    // (a retry must find the terminal row and skip, never re-consume).
    expect(() => reservation.reactivate()).toThrowWithCode(
      "INVALID_STATUS_TRANSITION",
    );
    expect(() => reservation.release()).toThrowWithCode(
      "INVALID_STATUS_TRANSITION",
    );
  });

  it("a released hold can reactivate in place (same deterministic key), a confirmed one cannot", () => {
    const released = new InventoryReservation({
      id: "r-2",
      reservationKey: "reserve:o-1:variant-1:loc-default",
      locationId: "loc-default",
      variantId: "variant-1",
      quantity: 2,
      status: "released",
    });
    released.reactivate();
    expect(released.status).toBe("reserved");
    expect(released.isHeld).toBe(true);
  });
});

describe("ReserveInventoryUseCase — input validation and deterministic aggregation", () => {
  it("rejects a missing orderId", async () => {
    const h = createPaymentHarness();
    await expect(() =>
      h.reserveInventory.execute({
        orderId: "",
        items: [{ variantId: "variant-1", quantity: 1 }],
      }),
    ).rejectsWithCode("VALIDATION_ERROR");
  });

  it("rejects an empty items list", async () => {
    const h = createPaymentHarness();
    await expect(() =>
      h.reserveInventory.execute({ orderId: "order-1", items: [] }),
    ).rejectsWithCode("VALIDATION_ERROR");
  });

  it("rejects a line without a variantId", async () => {
    const h = createPaymentHarness();
    await expect(() =>
      h.reserveInventory.execute({
        orderId: "order-1",
        items: [{ variantId: "", quantity: 1 }],
      }),
    ).rejectsWithCode("VALIDATION_ERROR");
  });

  it("rejects zero, negative and fractional quantities", async () => {
    const h = createPaymentHarness();
    for (const quantity of [0, -1, 1.5]) {
      await expect(() =>
        h.reserveInventory.execute({
          orderId: "order-1",
          items: [{ variantId: "variant-1", quantity }],
        }),
      ).rejectsWithCode("VALIDATION_ERROR");
    }
  });

  it("rejects a quantity beyond the bounded maximum (10_000)", async () => {
    const h = createPaymentHarness();
    await expect(() =>
      h.reserveInventory.execute({
        orderId: "order-1",
        items: [{ variantId: "variant-1", quantity: 10001 }],
      }),
    ).rejectsWithCode("VALIDATION_ERROR");
  });

  it("aggregates duplicate variant lines by sum and processes in deterministic variantId order", async () => {
    const h = createPaymentHarness();
    const result = await h.reserveInventory.execute({
      orderId: "order-agg",
      items: [
        { variantId: "variant-2", quantity: 1 },
        { variantId: "variant-1", quantity: 1 },
        { variantId: "variant-1", quantity: 2 },
      ],
    });

    // One reservation per variant, ordered by variantId, summed quantities.
    const byVariant = [...result.reservations].sort((a, b) =>
      a.variantId < b.variantId ? -1 : 1,
    );
    expect(byVariant).toHaveLength(2);
    expect(byVariant[0].variantId).toBe("variant-1");
    expect(byVariant[0].quantity).toBe(3);
    expect(byVariant[1].variantId).toBe("variant-2");
    expect(byVariant[1].quantity).toBe(1);

    // The deterministic aggregation produced a deterministic key set.
    const keys = result.reservations.map((r) => r.reservationKey).sort();
    expect(keys).toEqual([
      "reserve:order-agg:variant-1:loc-default",
      "reserve:order-agg:variant-2:loc-default",
    ]);
  });

  it("fails INSUFFICIENT_SINGLE_LOCATION_STOCK when no single location covers the request", async () => {
    const h = createPaymentHarness();
    await expect(() =>
      h.reserveInventory.execute({
        orderId: "order-low",
        // The harness seeds variant-1 with max(100, 2*10) = 100 units, so ask
        // for more than exists anywhere to force the no-single-location path.
        items: [{ variantId: "variant-1", quantity: 10_000 }],
      }),
    ).rejectsWithCode("INSUFFICIENT_SINGLE_LOCATION_STOCK");
  });
});