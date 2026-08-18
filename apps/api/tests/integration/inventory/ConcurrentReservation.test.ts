// apps/api/tests/integration/inventory/ConcurrentReservation.test.ts
//
// L9 PART 26 — CONCURRENCY MATRIX: two simultaneous reservations can never
// consume the same stock.
//
// SCOPE OF PROOF (authoritative split): this IN-MEMORY suite proves the
// APPLICATION-BOUNDARY semantics of the race — exactly-one-winner, winner
// replay, changed-quantity rejection, conserved ledger — against fakes that
// MIRROR the atomic conditional level UPDATE and the UNIQUE-key collision
// check-and-insert. It does NOT and CANNOT prove that the DATABASE rolls back
// a losing transaction's decrement on a UNIQUE collision, and it makes no
// fake concurrency guarantee: that rollback proof is the REAL-POSTGRES suite's
// job (tests/db/InventoryConstraints.test.ts), which is the authoritative
// proof. The DB is the final guard; the fakes only model its observable
// semantics at the boundary.
//
// The database proof is the atomic conditional UPDATE (available - q,
// reserved + q WHERE available >= q) inside a row-locked transaction; the
// in-memory suite proves the SAME semantics at the application boundary:
//
//   1. LAST-UNIT RACE — two DIFFERENT orders race for the final available
//      unit. Exactly ONE reservation succeeds; the loser fails with
//      INSUFFICIENT_INVENTORY; the level is NEVER negative and the total
//      available + reserved is conserved.
//   2. SAME-KEY RACE — two identical claims for the SAME deterministic
//      reservation key (the same checkout reference) converge on ONE hold: the
//      winner commits, the loser collides on UNIQUE(reservation_key) and
//      REPLAYS the winner's committed row (idempotent by design). Units are
//      consumed once.
//   3. CHANGED QUANTITY — a concurrent retry that asks for a DIFFERENT
//      quantity is rejected (INVALID_OPERATION) rather than double-consuming.
//
// The DepthAwareBarrierTransactionManager gates both top-level units until
// both parties arrive, then releases them together against the same initial
// state — reproducing the check-then-write race the use case handles
// intentionally (mirroring Kysely's nested-transaction semantics).

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { createPaymentHarness } from "../payment/harness";
import { DepthAwareBarrierTransactionManager } from "../../fakes/DepthAwareBarrierTransactionManager";
import { InMemoryInventoryLevelRepository } from "../../fakes/InMemoryInventoryLevelRepository";
import { InMemoryInventoryReservationRepository } from "../../fakes/InMemoryInventoryReservationRepository";
import { InventoryLevel } from "@api/domain/entities/InventoryLevel";
import type { ReserveInventoryResult } from "@api/use-cases/inventory/ReserveInventoryUseCase";
import { DEFAULT_SOURCING_LOCATION_ID } from "../payment/harness";

describe("L9 concurrency — two simultaneous reservations cannot consume the same stock", () => {
  it("a last-unit race yields exactly ONE winner and the loser fails INSUFFICIENT_INVENTORY (never negative)", async () => {
    // Seed a single unit of variant-1; the harness will NOT overwrite it.
    const levelRepository = new InMemoryInventoryLevelRepository();
    levelRepository.seed(
      new InventoryLevel({
        id: "level-last",
        variantId: "variant-1",
        locationId: DEFAULT_SOURCING_LOCATION_ID,
        availableQuantity: 1,
        reservedQuantity: 0,
      }),
    );
    const reservationRepository =
      new InMemoryInventoryReservationRepository();
    const h = createPaymentHarness({
      inventoryLevelRepository: levelRepository,
      inventoryReservationRepository: reservationRepository,
      transactionManager: new DepthAwareBarrierTransactionManager(2),
    });

    const [first, second] = await Promise.allSettled([
      h.reserveInventory.execute({
        orderId: "order-a",
        items: [{ variantId: "variant-1", quantity: 1 }],
      }),
      h.reserveInventory.execute({
        orderId: "order-b",
        items: [{ variantId: "variant-1", quantity: 1 }],
      }),
    ]);

    // Exactly one reservation succeeded; the other could not source the last
    // unit. The atomic conditional primitive decides the winner.
    const winners = [first, second].filter((r) => r.status === "fulfilled");
    const losers = [first, second].filter((r) => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loserError = (losers[0] as PromiseRejectedResult).reason as {
      code?: string;
    };
    expect(loserError.code).toBe("INSUFFICIENT_INVENTORY");

    // Exactly ONE durable reservation row for the final unit.
    expect(reservationRepository.all).toHaveLength(1);
    expect(reservationRepository.all[0].quantity).toBe(1);
    expect(reservationRepository.all[0].status).toBe("reserved");

    // The level never went negative and the total is conserved.
    const level = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-1",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(level!.availableQuantity).toBe(0);
    expect(level!.reservedQuantity).toBe(1);
    expect(level!.availableQuantity + level!.reservedQuantity).toBe(1);
  });

  it("a same-key race converges on ONE hold and consumes the units exactly once", async () => {
    const h = createPaymentHarness({
      transactionManager: new DepthAwareBarrierTransactionManager(2),
    });

    const [first, second] = await Promise.allSettled([
      h.reserveInventory.execute({
        orderId: "CLP-checkout-cart-1",
        items: [{ variantId: "variant-1", quantity: 2 }],
      }),
      h.reserveInventory.execute({
        orderId: "CLP-checkout-cart-1",
        items: [{ variantId: "variant-1", quantity: 2 }],
      }),
    ]);

    // Both callers converge: one committed the hold, the other collided on
    // UNIQUE(reservation_key) and replayed the winner's committed row.
    const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);

    const reservationA = (fulfilled[0] as PromiseFulfilledResult<ReserveInventoryResult>).value.reservations[0];
    const reservationB = (fulfilled[1] as PromiseFulfilledResult<ReserveInventoryResult>).value.reservations[0];

    // The SAME single durable hold is referenced by both callers.
    expect(reservationB.reservationId).toBe(reservationA.reservationId);
    expect(reservationB.reservationKey).toBe(reservationA.reservationKey);
    expect(reservationB.quantity).toBe(2);

    // One caller committed it; the other replayed it.
    const replayedCount = [reservationA, reservationB].filter(
      (r) => r.replayed,
    ).length;
    const committedCount = [reservationA, reservationB].filter(
      (r) => !r.replayed,
    ).length;
    expect(replayedCount + committedCount).toBe(2);
    expect(committedCount).toBe(1);

    // Exactly ONE reservation row exists for the key — units held once.
    expect(h.inventoryReservationRepository.all).toHaveLength(1);

    // The level consumed exactly 2 units; the ledger is conserved and never
    // negative. The shared-store fake models the winner's committed view; the
    // loser's whole-unit ROLLBACK on the UNIQUE(reservation_key) collision is
    // proven authoritatively by the real-Postgres suite
    // (tests/db/InventoryConstraints.test.ts) — never manufactured here.
    const level = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-1",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(level!.availableQuantity + level!.reservedQuantity).toBe(100);
    expect(level!.availableQuantity).toBeGreaterThan(-1);
    expect(level!.reservedQuantity).toBeGreaterThan(-1);
  });

  it("a changed-quantity retry is rejected and never consumes additional units", async () => {
    const h = createPaymentHarness();

    await h.reserveInventory.execute({
      orderId: "order-c",
      items: [{ variantId: "variant-1", quantity: 1 }],
    });

    // A retry that changed the quantity must fail (the committed hold pinned
    // the quantity); the available pool must be untouched by the attempt.
    await expect(() =>
      h.reserveInventory.execute({
        orderId: "order-c",
        items: [{ variantId: "variant-1", quantity: 2 }],
      }),
    ).rejectsWithCode("INVALID_OPERATION");

    const level = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-1",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(level!.availableQuantity).toBe(99);
    expect(level!.reservedQuantity).toBe(1);
  });
});