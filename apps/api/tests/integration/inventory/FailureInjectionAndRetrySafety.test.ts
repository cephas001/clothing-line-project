// apps/api/tests/integration/inventory/FailureInjectionAndRetrySafety.test.ts
//
// L9 PART 26 — FAILURE INJECTION: a DB failure after a reservation, and a
// logistics provider failure during dispatch, never corrupt inventory or money.
//
// The SnapshotTransactionManager reproduces the Postgres all-or-nothing
// boundary over the in-memory stores: a throw inside a unit of work restores
// every wrapped repository to its pre-unit state.
//
//   1. RESERVE — a DB write failure while persisting the reservation row
//      rolls back the level decrement (no partial hold); the retry succeeds
//      and the units are consumed exactly once.
//   2. FINALIZE — a DB failure while CONFIRMING the held units rolls back the
//      whole unit: no order, no transaction, cart unconverted, payment
//      uncaptured, units STILL held for the retry; the retry succeeds exactly
//      once. (See also InventoryPaymentIntegrity — this is the "no second
//      charge" guarantee.)
//   3. DISPATCH — an ambiguous logistics failure (timeout/network) persists
//      `requires_reconciliation`, never marks the order dispatched, and the
//      next dispatch attempt is REFUSED (Rule B) — the provider was contacted
//      at most once, so no duplicate shipment can be created.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import {
  createPaymentHarness,
  buildDefaultPaymentCart,
} from "../payment/harness";
import {
  createLogisticsHarness,
  buildDispatchShippingSnapshot,
  buildDispatchableOrder,
} from "../logistics/logisticsHarness";
import { SnapshotTransactionManager } from "../../fakes/SnapshotTransactionManager";
import { InMemoryCartRepository } from "../../fakes/InMemoryCartRepository";
import { InMemoryPaymentRepository } from "../../fakes/InMemoryPaymentRepository";
import { InMemoryOrderRepository } from "../../fakes/InMemoryOrderRepository";
import { InMemoryTransactionRepository } from "../../fakes/InMemoryTransactionRepository";
import { InMemoryInventoryLocationRepository } from "../../fakes/InMemoryInventoryLocationRepository";
import { InMemoryInventoryLevelRepository } from "../../fakes/InMemoryInventoryLevelRepository";
import { InMemoryInventoryReservationRepository } from "../../fakes/InMemoryInventoryReservationRepository";
import { Order } from "@api/domain/entities/Order";
import {
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import { DEFAULT_SOURCING_LOCATION_ID } from "../payment/harness";

const OBLIGATION_AMOUNT_MINOR = 61000;

const FINALIZE_INPUT = {
  cartId: "cart-1",
  transactionReference: "CLP-checkout-cart-1",
  amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
  currency: "ngn",
  expectedAmountMinor: OBLIGATION_AMOUNT_MINOR,
  actorId: "system",
};

/** A rollback-faithful harness: every store wrapped by one SnapshotTransactionManager. */
function rollbackHarness() {
  const cart = buildDefaultPaymentCart("cart-1");
  const cartRepository = new InMemoryCartRepository();
  cartRepository.seed(cart);
  const paymentRepository = new InMemoryPaymentRepository();
  const orderRepository = new InMemoryOrderRepository();
  const transactionRepository = new InMemoryTransactionRepository();
  const inventoryLocationRepository = new InMemoryInventoryLocationRepository();
  const inventoryLevelRepository = new InMemoryInventoryLevelRepository();
  const inventoryReservationRepository =
    new InMemoryInventoryReservationRepository();
  const transactionManager = new SnapshotTransactionManager([
    cartRepository,
    paymentRepository,
    orderRepository,
    transactionRepository,
    inventoryLocationRepository,
    inventoryLevelRepository,
    inventoryReservationRepository,
  ]);
  return createPaymentHarness({
    cart,
    cartRepository,
    paymentRepository,
    orderRepository,
    transactionRepository,
    transactionManager,
    inventoryLocationRepository,
    inventoryLevelRepository,
    inventoryReservationRepository,
  });
}

describe("Failure injection — DB failure during the reservation write rolls back the level", () => {
  it("a reservation-row write failure leaves the level untouched; the retry consumes exactly once", async () => {
    const h = rollbackHarness();

    // The reservation row insert/save fails mid-unit AFTER the level was
    // atomically decremented. The whole unit must roll back.
    h.inventoryReservationRepository.failNextSaveWith =
      RepositoryErrorCode.CONNECTION;

    await expect(() =>
      h.reserveInventory.execute({
        orderId: "order-1",
        items: [{ variantId: "variant-1", quantity: 2 }],
      }),
    ).rejectsWithCode("INTERNAL_ERROR");

    // No partial hold: the level is back to the pre-reserve state and no
    // reservation row exists.
    expect(h.inventoryReservationRepository.all).toHaveLength(0);
    const afterFailure = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-1",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(afterFailure!.availableQuantity).toBe(100);
    expect(afterFailure!.reservedQuantity).toBe(0);

    // A healthy retry commits exactly once.
    const result = await h.reserveInventory.execute({
      orderId: "order-1",
      items: [{ variantId: "variant-1", quantity: 2 }],
    });
    expect(result.reservations).toHaveLength(1);
    expect(h.inventoryReservationRepository.all).toHaveLength(1);
    const afterRetry = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-1",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(afterRetry!.availableQuantity).toBe(98);
    expect(afterRetry!.reservedQuantity).toBe(2);
  });
});

describe("Failure injection — DB failure while confirming during finalize rolls back the whole unit", () => {
  it("leaves the order unconverted, payment uncaptured and the units still held; the retry succeeds once", async () => {
    const h = rollbackHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    // Confirm runs INSIDE the finalize unit of work; a write failure there
    // must roll back the entire unit — never a half-finalized order.
    h.inventoryReservationRepository.failNextSaveWith =
      RepositoryErrorCode.CONNECTION;

    await expect(() =>
      h.finalizeOrderTransaction.execute(FINALIZE_INPUT),
    ).rejectsWithCode("INTERNAL_ERROR");

    // ZERO partial state: no order, no transaction, cart unconverted, payment
    // NOT captured, and the units are STILL held for the retry.
    expect(h.orderRepository.all).toHaveLength(0);
    expect(h.transactionRepository.all).toHaveLength(0);
    expect((await h.cartRepository.findById("cart-1"))!.isConverted()).toBe(
      false,
    );
    const obligation = await h.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    expect(obligation!.status).toBe("initialized");
    const stillHeld = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-1",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(stillHeld!.availableQuantity).toBe(98);
    expect(stillHeld!.reservedQuantity).toBe(2);
    for (const reservation of h.inventoryReservationRepository.all) {
      expect(reservation.status).toBe("reserved");
    }

    // A healthy retry (failure consumed) finalizes exactly once.
    const order = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);
    expect(h.orderRepository.all).toHaveLength(1);
    expect(h.transactionRepository.all).toHaveLength(1);
    expect((await h.paymentRepository.findByReference("CLP-checkout-cart-1"))!.status).toBe(
      "captured",
    );
    const consumed = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-1",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(consumed!.availableQuantity).toBe(98);
    expect(consumed!.reservedQuantity).toBe(0);
    expect(order.transactionReference).toBe("CLP-checkout-cart-1");
  });
});

describe("Failure injection — ambiguous logistics failure never creates a duplicate shipment", () => {
  it("persists requires_reconciliation, refuses the next dispatch, and the provider is contacted at most once", async () => {
    const order = new Order({
      id: "order-1",
      cartId: "cart-1",
      customerId: "customer-1",
      totalAmountMinor: 61000,
      currency: "ngn",
      subtotalMinor: 60000,
      discountMinor: 5000,
      taxMinor: 3000,
      shippingMinor: 2500,
      insuranceMinor: 500,
      transactionReference: "CLP-checkout-cart-1",
      paymentStatus: "captured",
      fulfillmentStatus: "unfulfilled",
      shippingSnapshot: buildDispatchShippingSnapshot(),
      sourcingSnapshot: {
        frozenAt: "2026-08-16T10:00:00Z",
        variantLines: [
          { variantId: "variant-1", quantity: 2, locationId: "loc-default" },
        ],
        primaryLocationId: "loc-default",
        origin: {
          locationId: "loc-default",
          name: "Origin Studio Lagos",
          email: "origin@originstudio.test",
          phone: "+2348000000000",
          address: "12 Marina Road, Lagos Island, Lagos",
          providerAddressCode: null,
        },
      },
    });

    const h = createLogisticsHarness({ order });
    h.logisticsService.failCreateWithCode = RepositoryErrorCode.CONNECTION;
    h.logisticsService.failCreateAmbiguous = true;

    // Ambiguous timeout: the shipment may or may not exist provider-side. The
    // order is NOT marked dispatched and a reconciliation marker is durable.
    await expect(() =>
      h.dispatchOrderFulfillment.execute({ orderId: "order-1" }),
    ).rejectsWithCode("SHIPMENT_REQUIRES_RECONCILIATION");

    expect(h.logisticsService.labelRequests).toHaveLength(1);
    expect(
      (await h.orderRepository.findById("order-1"))!.fulfillmentStatus,
    ).toBe("unfulfilled");
    expect(h.fulfillmentRepository.all).toHaveLength(1);
    expect(
      (h.fulfillmentRepository.all[0] as { status?: string }).status,
    ).toBe("requires_reconciliation");

    // Rule B: a recorded ambiguous outcome refuses another automatic dispatch —
    // the provider is NEVER contacted again. A fresh worker load rehydrates the
    // order WITH the durable marker on its fulfillments column (the same model
    // the L6 suite uses to prove rehydration carries the marker).
    const rehydrated = buildDispatchableOrder({
      fulfillments: h.fulfillmentRepository.all,
    });
    h.orderRepository.seed(rehydrated);
    await expect(() =>
      h.dispatchOrderFulfillment.execute({ orderId: "order-1" }),
    ).rejectsWithCode("SHIPMENT_REQUIRES_RECONCILIATION");
    expect(h.logisticsService.labelRequests).toHaveLength(1);
  });
});