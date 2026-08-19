// apps/api/tests/integration/payment/InventoryPaymentIntegrity.test.ts
//
// L9 PART 27 — FINANCIAL REGRESSION: inventory capability must NOT weaken the
// authoritative payment architecture.
//
//   1. AMOUNT AUTHORITY — `Payment.amountMinor === authoritative checkout
//      total` and the equivalence holds across the WHOLE chain: the frozen
//      obligation, the gateway initialization, the created Order and the
//      transaction ledger all carry the SAME single authoritative amount.
//   2. NO CHARGE ON SHORTFALL — an inventory shortfall at claim time fails the
//      WHOLE claim: no obligation is created and the gateway is NEVER
//      contacted. Inventory failure can never initiate or retry a charge
//      (INV-I5).
//   3. NO SECOND CHARGE ON INVENTORY FAILURE — a DB failure while confirming
//      the held units during finalize rolls back the entire unit of work; the
//      payment stays uncaptured and the gateway was contacted exactly once for
//      the whole lifecycle. The retry finalizes once. Inventory failure can
//      never cause a second charge.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import {
  createPaymentHarness,
  buildDefaultPaymentCart,
} from "./harness";
import { SnapshotTransactionManager } from "../../fakes/SnapshotTransactionManager";
import { InMemoryCartRepository } from "../../fakes/InMemoryCartRepository";
import { InMemoryPaymentRepository } from "../../fakes/InMemoryPaymentRepository";
import { InMemoryOrderRepository } from "../../fakes/InMemoryOrderRepository";
import { InMemoryTransactionRepository } from "../../fakes/InMemoryTransactionRepository";
import { InMemoryInventoryLocationRepository } from "../../fakes/InMemoryInventoryLocationRepository";
import { InMemoryInventoryLevelRepository } from "../../fakes/InMemoryInventoryLevelRepository";
import { InMemoryInventoryReservationRepository } from "../../fakes/InMemoryInventoryReservationRepository";
import { InventoryLevel } from "@api/domain/entities/InventoryLevel";
import {
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import { DEFAULT_SOURCING_LOCATION_ID } from "./harness";

const OBLIGATION_AMOUNT_MINOR = 61000;

const FINALIZE_INPUT = {
  cartId: "cart-1",
  transactionReference: "CLP-checkout-cart-1",
  amountPaidMinor: OBLIGATION_AMOUNT_MINOR,
  currency: "ngn",
  expectedAmountMinor: OBLIGATION_AMOUNT_MINOR,
  actorId: "system",
};

describe("PART 27 — Payment.amountMinor === authoritative checkout total across the chain", () => {
  it("the frozen obligation, gateway call, order and transaction ledger all carry the SAME amount", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    // The frozen obligation is the authoritative total: 60_000 - 5_000 + 3_000
    // + 2_500 + 500 = 61_000.
    const obligation = await h.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    expect(obligation).not.toBeNull();
    expect(obligation!.amountMinor).toBe(OBLIGATION_AMOUNT_MINOR);
    expect(obligation!.breakdown.totalMinor).toBe(OBLIGATION_AMOUNT_MINOR);
    expect(
      obligation!.breakdown.subtotalMinor -
        obligation!.breakdown.discountMinor +
        obligation!.breakdown.taxMinor +
        obligation!.breakdown.shippingMinor +
        obligation!.breakdown.insuranceMinor,
    ).toBe(obligation!.amountMinor);

    // The gateway received EXACTLY the frozen amount — nothing else.
    expect(h.paymentService.checkoutInitializations).toHaveLength(1);
    expect(h.paymentService.checkoutInitializations[0].amountMinor).toBe(
      OBLIGATION_AMOUNT_MINOR,
    );

    // Finalize: order + transaction mirror the same single amount.
    const order = await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);
    expect(order.totalAmountMinor).toBe(obligation!.amountMinor);
    expect(order.subtotalMinor).toBe(obligation!.subtotalMinor);
    expect(order.discountMinor).toBe(obligation!.discountMinor);
    expect(order.taxMinor).toBe(obligation!.taxMinor);
    expect(order.shippingMinor).toBe(obligation!.shippingMinor);
    expect(order.insuranceMinor).toBe(obligation!.insuranceMinor);
    expect(h.transactionRepository.all).toHaveLength(1);
    expect(h.transactionRepository.all[0].amountMinor).toBe(
      obligation!.amountMinor,
    );
  });
});

describe("PART 27 — inventory failure can never initiate or retry a charge", () => {
  it("an inventory shortfall at claim fails the WHOLE claim: no obligation, no gateway contact", async () => {
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
    const h = createPaymentHarness({ inventoryLevelRepository: levelRepository });

    await expect(() =>
      h.initializePaymentSession.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("INSUFFICIENT_SINGLE_LOCATION_STOCK");

    // No durable obligation, no gateway initialization — inventory failure is
    // surfaced to the caller, which decides the outcome. Inventory NEVER
    // contacts a payment provider (INV-I5).
    expect(h.paymentRepository.all).toHaveLength(0);
    expect(h.paymentService.checkoutInitializations).toHaveLength(0);
  });

  it("a confirm-time inventory DB failure during finalize can never cause a second charge", async () => {
    // Build ONE set of stores wrapped in a SnapshotTransactionManager so the
    // failed finalize rolls back exactly like the Postgres boundary.
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
    const h = createPaymentHarness({
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

    await h.initializePaymentSession.execute({ cartId: "cart-1" });
    expect(h.paymentService.checkoutInitializations).toHaveLength(1);

    // The gateway init succeeded once — the ONLY provider interaction the
    // whole lifecycle will ever have. Now the inventory confirm fails inside
    // the finalize unit of work.
    h.inventoryReservationRepository.failNextSaveWith =
      RepositoryErrorCode.CONNECTION;
    await expect(() =>
      h.finalizeOrderTransaction.execute(FINALIZE_INPUT),
    ).rejectsWithCode("INTERNAL_ERROR");

    // Payment is NOT captured, the cart is NOT converted, no order/ledger row.
    expect((await h.paymentRepository.findByReference("CLP-checkout-cart-1"))!.status).toBe(
      "initialized",
    );
    expect((await h.cartRepository.findById("cart-1"))!.isConverted()).toBe(
      false,
    );
    expect(h.orderRepository.all).toHaveLength(0);
    expect(h.transactionRepository.all).toHaveLength(0);

    // Retry finalizes exactly once — and the gateway was STILL contacted
    // exactly once across the whole lifecycle. A second charge is impossible.
    await h.finalizeOrderTransaction.execute(FINALIZE_INPUT);
    expect(h.orderRepository.all).toHaveLength(1);
    expect(h.transactionRepository.all).toHaveLength(1);
    expect(h.paymentRepository.all).toHaveLength(1);
    expect(h.paymentService.checkoutInitializations).toHaveLength(1);
    expect(
      (await h.paymentRepository.findByReference("CLP-checkout-cart-1"))!
        .status,
    ).toBe("captured");
  });
});