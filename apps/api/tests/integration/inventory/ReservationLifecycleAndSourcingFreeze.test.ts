// apps/api/tests/integration/inventory/ReservationLifecycleAndSourcingFreeze.test.ts
//
// L9 Part 3 — the checkout reservation lifecycle + sourcing-snapshot freeze.
//
// Proves the full reserve -> confirm -> release wiring through the authoritative
// checkout use cases (initialize / finalize / reset):
//
//   1. InitializePaymentSessionUseCase reserves the CHARGED variant lines
//      atomically with the obligation claim (anchored on the deterministic
//      payment reference, with the checkout hold TTL), so a payment can never
//      exist without a matching inventory hold.
//   2. Insufficient stock fails the WHOLE claim — no obligation, no partial
//      holds, no mutated levels.
//   3. FinalizeOrderTransactionUseCase confirms the held units and FREEZES the
//      provider-neutral OrderSourcingSnapshot (variant -> location -> quantity,
//      deterministic primary location, shipment origin from the location's
//      LOCAL sender record) inside the same unit of work as the order.
//   4. Duplicate finalization is idempotent: confirmation never double-consumes.
//   5. ResetFailedPaymentInitializationUseCase RELEASES the hold, returning the
//      units to the available pool.
//   6. Custom-only carts (no variant-backed lines) skip the reservation; the
//      finalized order carries a null sourcing snapshot and dispatch still
//      works through the legacy path.
//   7. Dispatch consumes the frozen snapshot: the label request origin comes
//      EXCLUSIVELY from Order.sourcingSnapshot.origin and the fulfillment
//      record freezes sourcingLocationId from primaryLocationId.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import {
  createPaymentHarness,
  DEFAULT_SOURCING_LOCATION_ID,
} from "../payment/harness";
import { Cart } from "@api/domain/entities/Cart";
import { CartLineItem } from "@api/domain/entities/CartLineItem";
import { InventoryLevel } from "@api/domain/entities/InventoryLevel";
import { Order } from "@api/domain/entities/Order";
import { InMemoryInventoryLevelRepository } from "../../fakes/InMemoryInventoryLevelRepository";
import {
  buildDispatchShippingSnapshot,
  createLogisticsHarness,
} from "../logistics/logisticsHarness";

const OBLIGATION_AMOUNT_MINOR = 61000;
const CHECKOUT_RESERVATION_TTL_MS = 30 * 60 * 1000;

const FINALIZE_INPUT = {
  cartId: "cart-1",
  transactionReference: "CLP-checkout-cart-1",
  amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
  currency: "ngn",
  expectedAmountMinor: OBLIGATION_AMOUNT_MINOR,
  actorId: "system",
};

/** A payment-ready cart with NO variant-backed line items (custom-only). */
function buildCustomOnlyCart(id = "cart-1"): Cart {
  const cart = new Cart({
    id,
    regionId: "region-ng",
    salesChannelId: "sales-channel-main",
    customerId: "customer-1",
    email: "buyer@example.com",
    countryCode: "NG",
    shippingAddress: {
      firstName: "Ada",
      lastName: "Okafor",
      line1: "1 Marina Street",
      city: "Lagos",
      state: "Lagos",
      postalCode: "101001",
      countryCode: "NG",
      phone: "+2348000000000",
    },
    items: [
      new CartLineItem({
        id: "line-1",
        cartId: id,
        variantId: null,
        quantity: 1,
        unitPriceMinor: 15000,
        title: "Custom Made Belt",
        createdAt: new Date().toISOString(),
      }),
    ],
  });
  cart.recordShippingQuotes([
    {
      id: "quote-1",
      serviceLevel: "Express",
      amountMinor: 2500,
      currency: "ngn",
      etaDays: 3,
      courierId: "courier-1",
      serviceCode: "SC-EXPRESS",
      requestToken: "request-token-1",
    },
  ]);
  cart.applySelectedShippingQuote({
    quoteId: "quote-1",
    courierId: "courier-1",
    serviceCode: "SC-EXPRESS",
    requestToken: "request-token-1",
    amountMinor: 2500,
    serviceLevel: "Express",
    currency: "ngn",
    etaDays: 3,
  });
  return cart;
}

describe("L9 reservation lifecycle — hold at claim, confirm at finalize", () => {
  it("initialize reserves the charged variant lines atomically with the obligation claim", async () => {
    const h = createPaymentHarness();

    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    // Two deterministic reservation rows anchored on the payment reference,
    // with the checkout hold TTL (never a permanent hold).
    const reservations = h.inventoryReservationRepository.all;
    expect(reservations).toHaveLength(2);
    reservations.sort((a, b) => (a.variantId < b.variantId ? -1 : 1));

    const v1 = reservations[0];
    expect(v1.variantId).toBe("variant-1");
    expect(v1.locationId).toBe(DEFAULT_SOURCING_LOCATION_ID);
    expect(v1.quantity).toBe(2);
    expect(v1.status).toBe("reserved");
    expect(v1.orderId).toBe("CLP-checkout-cart-1");
    expect(v1.expiresAt).not.toBeNull();
    expect(Date.parse(v1.expiresAt!)).toBeGreaterThan(Date.now());
    expect(Date.parse(v1.expiresAt!)).toBeLessThan(
      Date.now() + CHECKOUT_RESERVATION_TTL_MS + 1000,
    );

    const v2 = reservations[1];
    expect(v2.variantId).toBe("variant-2");
    expect(v2.locationId).toBe(DEFAULT_SOURCING_LOCATION_ID);
    expect(v2.quantity).toBe(1);
    expect(v2.status).toBe("reserved");
    expect(v2.orderId).toBe("CLP-checkout-cart-1");

    // The levels moved the units from available into the reserved bucket.
    const levelV1 = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-1",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(levelV1!.availableQuantity).toBe(98);
    expect(levelV1!.reservedQuantity).toBe(2);
    const levelV2 = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-2",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(levelV2!.availableQuantity).toBe(99);
    expect(levelV2!.reservedQuantity).toBe(1);

    // The reservation is audited after the unit commits.
    expect(h.auditLogService.actions().includes("INVENTORY_RESERVED")).toBe(true);
  });

  it("insufficient stock fails the WHOLE claim — no obligation, no partial holds", async () => {
    // Pre-seed a level with insufficient stock for variant-1 (qty 2 requested).
    // The harness will NOT overwrite an existing level.
    const levelRepository = new InMemoryInventoryLevelRepository();
    levelRepository.seed(
      new InventoryLevel({
        id: "level-low",
        variantId: "variant-1",
        locationId: DEFAULT_SOURCING_LOCATION_ID,
        availableQuantity: 1,
        reservedQuantity: 0,
      }),
    );

    const h = createPaymentHarness({
      inventoryLevelRepository: levelRepository,
    });

    await expect(() =>
      h.initializePaymentSession.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("INSUFFICIENT_SINGLE_LOCATION_STOCK");

    // No obligation was created and no reservation rows exist.
    expect(h.paymentRepository.all).toHaveLength(0);
    expect(h.inventoryReservationRepository.all).toHaveLength(0);

    // No level was mutated — the failed claim left no partial decrement.
    const levelV1 = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-1",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(levelV1!.availableQuantity).toBe(1);
    expect(levelV1!.reservedQuantity).toBe(0);
    const levelV2 = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-2",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(levelV2!.availableQuantity).toBe(100);
    expect(levelV2!.reservedQuantity).toBe(0);

    // The cart remains free to retry.
    expect(h.cart.isPaymentInitialized()).toBe(false);
  });

  it("finalize confirms the held units and freezes the sourcing snapshot", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    const order = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);

    // The held units were CONSUMED exactly once: reserved returns to 0 while
    // available stays at the post-reserve level.
    const levelV1 = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-1",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(levelV1!.availableQuantity).toBe(98);
    expect(levelV1!.reservedQuantity).toBe(0);
    const levelV2 = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-2",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(levelV2!.availableQuantity).toBe(99);
    expect(levelV2!.reservedQuantity).toBe(0);

    // Every reservation row is terminal confirmed.
    for (const reservation of h.inventoryReservationRepository.all) {
      expect(reservation.status).toBe("confirmed");
    }

    // The order FREEZES the provider-neutral sourcing snapshot.
    const snapshot = order.sourcingSnapshot;
    expect(snapshot).not.toBeNull();
    expect(snapshot!.frozenAt).toBe(order.createdAt);
    expect(snapshot!.variantLines).toEqual([
      { variantId: "variant-1", quantity: 2, locationId: DEFAULT_SOURCING_LOCATION_ID },
      { variantId: "variant-2", quantity: 1, locationId: DEFAULT_SOURCING_LOCATION_ID },
    ]);
    expect(snapshot!.primaryLocationId).toBe(DEFAULT_SOURCING_LOCATION_ID);
    // The origin comes from the location's LOCAL sender record — never a
    // provider decision.
    expect(snapshot!.origin).toEqual({
      locationId: DEFAULT_SOURCING_LOCATION_ID,
      name: "Origin Studio Lagos",
      email: "origin@originstudio.test",
      phone: "+2348000000000",
      address: "12 Marina Road, Lagos Island, Lagos",
      providerAddressCode: null,
    });
  });

  it("a duplicate finalization never double-consumes the reserved units", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    const first = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);
    const second = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);

    expect(second.id).toBe(first.id);
    expect(h.orderRepository.all).toHaveLength(1);

    // Units consumed exactly once.
    const levelV1 = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-1",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(levelV1!.availableQuantity).toBe(98);
    expect(levelV1!.reservedQuantity).toBe(0);

    // The replayed order resolves to the SAME frozen snapshot (no regeneration).
    expect(second.sourcingSnapshot).toEqual(first.sourcingSnapshot);
  });
});

describe("L9 reservation release — reset returns the hold to the available pool", () => {
  it("reset releases the reserved units and marks the rows released", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    const reset = await h.resetFailedPaymentInitialization.execute({
      cartId: "cart-1",
      actorId: "customer-1",
    });
    expect(reset.resettled).toBe(true);

    // Units returned to the available pool.
    const levelV1 = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-1",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(levelV1!.availableQuantity).toBe(100);
    expect(levelV1!.reservedQuantity).toBe(0);
    const levelV2 = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-2",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(levelV2!.availableQuantity).toBe(100);
    expect(levelV2!.reservedQuantity).toBe(0);

    // Every reservation row is terminal released.
    for (const reservation of h.inventoryReservationRepository.all) {
      expect(reservation.status).toBe("released");
    }
  });

  it("a re-initialization after reset re-reserves on the deterministic per-attempt reference", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });
    await h.resetFailedPaymentInitialization.execute({ cartId: "cart-1" });

    // Reset produced a NEW attempt reference (-A1); the next claim anchors the
    // hold there and re-consumes the available units.
    const second = await h.initializePaymentSession.execute({ cartId: "cart-1" });
    expect(second.reference).toBe("CLP-checkout-cart-1-A1");

    // The prior attempt's released rows are preserved; the NEW hold is anchored
    // on the per-attempt reference and is the only ACTIVE reservation.
    expect(h.inventoryReservationRepository.all).toHaveLength(4);
    const held = h.inventoryReservationRepository.all.filter(
      (r) => r.orderId === "CLP-checkout-cart-1-A1",
    );
    expect(held).toHaveLength(2);
    held.sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
    expect(held[0].status).toBe("reserved");
    expect(held[0].variantId).toBe("variant-1");
    expect(held[0].quantity).toBe(2);
    expect(held[1].status).toBe("reserved");
    expect(held[1].variantId).toBe("variant-2");
    expect(held[1].quantity).toBe(1);

    const levelV1 = await h.inventoryLevelRepository.findByVariantAndLocation(
      "variant-1",
      DEFAULT_SOURCING_LOCATION_ID,
    );
    expect(levelV1!.availableQuantity).toBe(98);
    expect(levelV1!.reservedQuantity).toBe(2);
  });
});

describe("L9 sourcing snapshot — legacy/custom-only orders carry no snapshot", () => {
  it("a custom-only cart skips the reservation and finalizes with a null snapshot", async () => {
    const h = createPaymentHarness({ cart: buildCustomOnlyCart("cart-1") });

    // No variant-backed lines -> no reservation attempt at all.
    await h.initializePaymentSession.execute({ cartId: "cart-1" });
    expect(h.inventoryReservationRepository.all).toHaveLength(0);

    // The obligation total reflects the custom line (15000 + 2500 shipping).
    const obligation = await h.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    const amountMinor = obligation!.amountMinor;

    const order = await h.finalizeOrderTransaction.execute({
      cartId: "cart-1",
      transactionReference: "CLP-checkout-cart-1",
      amountPaidMinor: amountMinor,
      currency: "ngn",
      expectedAmountMinor: amountMinor,
      actorId: "system",
    });

    expect(order.sourcingSnapshot).toBeNull();
    expect(order.shippingSnapshot).not.toBeNull();
  });
});

describe("L9 dispatch — the frozen sourcing snapshot is consumed verbatim", () => {
  it("dispatch sends Order.sourcingSnapshot.origin and freezes sourcingLocationId", async () => {
    const snapshot = {
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
    };

    const order = buildDispatchableOrderWithSourcingSnapshot(snapshot);
    const h = createLogisticsHarness({ order });

    const result = await h.dispatchOrderFulfillment.execute({ orderId: "order-1" });
    expect(result.dispatchState).toBe("dispatched");

    // The label request carries the FROZEN origin verbatim (never re-fetched
    // from the mutable inventory tables).
    expect(h.logisticsService.labelRequests).toHaveLength(1);
    const request = h.logisticsService.labelRequests[0];
    expect(request.origin).toEqual(snapshot.origin);

    // The fulfillment record freezes which location sourced the order.
    const fulfillment = h.fulfillmentRepository.all[0];
    expect(fulfillment.sourcingLocationId).toBe("loc-default");
  });

  it("a legacy order without a sourcing snapshot dispatches with a null origin", async () => {
    // buildDispatchableOrder carries no sourcingSnapshot by default.
    const h = createLogisticsHarness();

    const result = await h.dispatchOrderFulfillment.execute({ orderId: "order-1" });
    expect(result.dispatchState).toBe("dispatched");

    const request = h.logisticsService.labelRequests[0];
    expect(request.origin).toBeNull();
    expect(request.orderId).toBe("order-1");
    expect(h.fulfillmentRepository.all[0].sourcingLocationId).toBeUndefined();
  });
});

/** Build a finalized, dispatchable order carrying a frozen sourcing snapshot. */
function buildDispatchableOrderWithSourcingSnapshot(
  snapshot: Order["sourcingSnapshot"],
): Order {
  return new Order({
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
    sourcingSnapshot: snapshot,
  });
}
