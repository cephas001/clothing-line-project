// apps/api/tests/integration/payment/harness.ts
//
// Shared composition harness for the L6 payment INTEGRATION suites. Wires the
// in-memory fakes exactly as the real composition root wires infrastructure,
// and exposes the three use cases that form the authoritative payment
// lifecycle:
//
//   InitializePaymentSessionUseCase  -> claim obligation + gateway init
//   VerifyPaymentEventUseCase        -> webhook verification gate
//   FinalizeOrderTransactionUseCase  -> idempotent order finalization
//
// Every test seeds a payment-ready cart and region, then drives the use cases
// through the interface contracts. No HTTP, no Postgres, no Paystack — the
// financial invariants are exercised at the application boundary.

import { Cart } from "@api/domain/entities/Cart";
import { Region } from "@api/domain/entities/Region";
import { InventoryLocation } from "@api/domain/entities/InventoryLocation";
import { InventoryLevel } from "@api/domain/entities/InventoryLevel";
import type { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { InitializePaymentSessionUseCase } from "@api/use-cases/checkout/InitializePaymentSessionUseCase";
import { VerifyPaymentEventUseCase } from "@api/use-cases/checkout/VerifyPaymentEventUseCase";
import { FinalizeOrderTransactionUseCase } from "@api/use-cases/checkout/FinalizeOrderTransactionUseCase";
import { ResetFailedPaymentInitializationUseCase } from "@api/use-cases/checkout/ResetFailedPaymentInitializationUseCase";
import { ReserveInventoryUseCase } from "@api/use-cases/inventory/ReserveInventoryUseCase";
import { ConfirmInventoryReservationUseCase } from "@api/use-cases/inventory/ConfirmInventoryReservationUseCase";
import { ReleaseInventoryReservationUseCase } from "@api/use-cases/inventory/ReleaseInventoryReservationUseCase";
import { InMemoryCartRepository } from "../../fakes/InMemoryCartRepository";
import { InMemoryRegionRepository } from "../../fakes/InMemoryRegionRepository";
import { InMemoryPaymentRepository } from "../../fakes/InMemoryPaymentRepository";
import { InMemoryOrderRepository } from "../../fakes/InMemoryOrderRepository";
import { InMemoryTransactionRepository } from "../../fakes/InMemoryTransactionRepository";
import { InMemoryNotificationOutboxRepository } from "../../fakes/InMemoryNotificationOutboxRepository";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { InMemoryTransactionManager } from "../../fakes/InMemoryTransactionManager";
import { InMemoryInventoryLocationRepository } from "../../fakes/InMemoryInventoryLocationRepository";
import { InMemoryInventoryLevelRepository } from "../../fakes/InMemoryInventoryLevelRepository";
import { InMemoryInventoryReservationRepository } from "../../fakes/InMemoryInventoryReservationRepository";
import { FakePaymentService } from "../../fakes/FakePaymentService";
import { SequenceIdGenerator } from "../../fakes/SequenceIdGenerator";
import { NoopLogger } from "../../fakes/NoopLogger";
import { buildCheckoutCart } from "../../fixtures/cartFactory";
import { buildRegion } from "../../fixtures/regionFactory";
import { buildFixedPromotion } from "../../fixtures/promotionFactory";

/**
 * The default active sourcing node seeded by the harness, with a COMPLETE
 * LOCAL sender record (the deterministic single-origin rule prefers it, and
 * the finalization-time sourcing snapshot freezes its origin from this record —
 * never from Shipbubble).
 */
export const DEFAULT_SOURCING_LOCATION_ID = "loc-default";
const DEFAULT_SOURCING_LOCATION_CODE = "LOC-DEFAULT";

export interface PaymentHarnessOptions {
  cart?: Cart;
  region?: Region;
  /**
   * Override the transaction manager. Defaults to InMemoryTransactionManager
   * (immediate writes, no rollback). Race tests pass a BarrierTransactionManager
   * and rollback tests pass a SnapshotTransactionManager wrapping the stores.
   */
  transactionManager?: ITransactionManager;
  /**
   * Override a repository so the harness reuses an EXISTING store (e.g. one
   * already wrapped by a SnapshotTransactionManager). Defaults to a fresh
   * in-memory store per harness.
   */
  cartRepository?: InMemoryCartRepository;
  paymentRepository?: InMemoryPaymentRepository;
  orderRepository?: InMemoryOrderRepository;
  transactionRepository?: InMemoryTransactionRepository;
  /** Override the notification outbox store (e.g. one wrapped by a SnapshotTransactionManager). */
  notificationOutboxRepository?: InMemoryNotificationOutboxRepository;
  /** Override the L9 inventory stores (e.g. one wrapped by a SnapshotTransactionManager). */
  inventoryLocationRepository?: InMemoryInventoryLocationRepository;
  inventoryLevelRepository?: InMemoryInventoryLevelRepository;
  inventoryReservationRepository?: InMemoryInventoryReservationRepository;
}

export interface PaymentHarness {
  cart: Cart;
  region: Region;
  cartRepository: InMemoryCartRepository;
  paymentRepository: InMemoryPaymentRepository;
  regionRepository: InMemoryRegionRepository;
  orderRepository: InMemoryOrderRepository;
  transactionRepository: InMemoryTransactionRepository;
  notificationOutboxRepository: InMemoryNotificationOutboxRepository;
  inventoryLocationRepository: InMemoryInventoryLocationRepository;
  inventoryLevelRepository: InMemoryInventoryLevelRepository;
  inventoryReservationRepository: InMemoryInventoryReservationRepository;
  paymentService: FakePaymentService;
  auditLogService: InMemoryAuditLogService;
  initializePaymentSession: InitializePaymentSessionUseCase;
  verifyPaymentEvent: VerifyPaymentEventUseCase;
  finalizeOrderTransaction: FinalizeOrderTransactionUseCase;
  resetFailedPaymentInitialization: ResetFailedPaymentInitializationUseCase;
  reserveInventory: ReserveInventoryUseCase;
  confirmInventoryReservation: ConfirmInventoryReservationUseCase;
  releaseInventoryReservation: ReleaseInventoryReservationUseCase;
}

/**
 * The canonical payment-ready cart used across the payment suites:
 *   subtotal 60_000 - discount 5_000 + tax 3_000 + shipping 2_500
 *   + insurance 500 = 61_000.
 */
export function buildDefaultPaymentCart(id = "cart-1"): Cart {
  return buildCheckoutCart({
    id,
    customerId: "customer-1",
    email: "buyer@example.com",
    promotion: buildFixedPromotion("SAVE5K", 5000),
    taxAmountMinor: 3000,
    shippingAmountMinor: 2500,
    insuranceAmountMinor: 500,
  });
}

export function createPaymentHarness(
  options: PaymentHarnessOptions = {},
): PaymentHarness {
  const region = options.region ?? buildRegion();
  const cart = options.cart ?? buildDefaultPaymentCart("cart-1");

  const cartRepository = options.cartRepository ?? new InMemoryCartRepository();
  cartRepository.seed(cart);

  const regionRepository = new InMemoryRegionRepository();
  regionRepository.seed(region);

  const paymentRepository =
    options.paymentRepository ?? new InMemoryPaymentRepository();
  const orderRepository =
    options.orderRepository ?? new InMemoryOrderRepository();
  const transactionRepository =
    options.transactionRepository ?? new InMemoryTransactionRepository();

  const notificationOutboxRepository =
    options.notificationOutboxRepository ?? new InMemoryNotificationOutboxRepository();

  // --- L9 inventory stores: the default active sourcing node with a COMPLETE
  // LOCAL sender record + a level for EVERY cart variant. The level quantity
  // is derived from the cart line (max(100, qty * 10)) so any payment-ready
  // cart resolves its reservation without touching production stock.
  const inventoryLocationRepository =
    options.inventoryLocationRepository ?? new InMemoryInventoryLocationRepository();
  if (inventoryLocationRepository.all.length === 0) {
    inventoryLocationRepository.seed(
      new InventoryLocation({
        id: DEFAULT_SOURCING_LOCATION_ID,
        code: DEFAULT_SOURCING_LOCATION_CODE,
        name: "Origin Studio Lagos",
        isActive: true,
        priority: 0,
        senderAddress: {
          name: "Origin Studio Lagos",
          email: "origin@originstudio.test",
          phone: "+2348000000000",
          address: "12 Marina Road, Lagos Island, Lagos",
        },
        providerAddressCode: null,
      }),
    );
  }

  const inventoryLevelRepository =
    options.inventoryLevelRepository ?? new InMemoryInventoryLevelRepository();
  for (const item of cart.items) {
    const variantId = item.variantId;
    if (!variantId) {
      continue;
    }
    const key = `${DEFAULT_SOURCING_LOCATION_ID}:${variantId}`;
    const seeded = inventoryLevelRepository.all.some(
      (level) => level.locationId === DEFAULT_SOURCING_LOCATION_ID && level.variantId === variantId,
    );
    if (!seeded) {
      inventoryLevelRepository.seed(
        new InventoryLevel({
          id: `level-${key}`,
          variantId,
          locationId: DEFAULT_SOURCING_LOCATION_ID,
          availableQuantity: Math.max(100, item.quantity * 10),
          reservedQuantity: 0,
        }),
      );
    }
  }

  const inventoryReservationRepository =
    options.inventoryReservationRepository ?? new InMemoryInventoryReservationRepository();

  const paymentService = new FakePaymentService();
  const auditLogService = new InMemoryAuditLogService();
  const idGenerator = new SequenceIdGenerator();
  const logger = new NoopLogger();
  const transactionManager =
    options.transactionManager ?? new InMemoryTransactionManager();

  // L9 inventory orchestration use cases, wired exactly as the composition
  // root wires them for the checkout flow.
  const reserveInventory = new ReserveInventoryUseCase(
    inventoryLocationRepository,
    inventoryLevelRepository,
    inventoryReservationRepository,
    transactionManager,
    auditLogService,
    idGenerator,
    logger,
  );
  const confirmInventoryReservation = new ConfirmInventoryReservationUseCase(
    inventoryLevelRepository,
    inventoryReservationRepository,
    transactionManager,
    auditLogService,
    idGenerator,
    logger,
  );
  const releaseInventoryReservation = new ReleaseInventoryReservationUseCase(
    inventoryLevelRepository,
    inventoryReservationRepository,
    transactionManager,
    auditLogService,
    idGenerator,
    logger,
  );

  const initializePaymentSession = new InitializePaymentSessionUseCase(
    cartRepository,
    paymentRepository,
    paymentService,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
    regionRepository,
    reserveInventory,
  );

  const verifyPaymentEvent = new VerifyPaymentEventUseCase(
    paymentRepository,
    auditLogService,
    idGenerator,
    logger,
  );

  const finalizeOrderTransaction = new FinalizeOrderTransactionUseCase(
    orderRepository,
    transactionRepository,
    paymentRepository,
    cartRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
    notificationOutboxRepository,
    confirmInventoryReservation,
    inventoryReservationRepository,
    inventoryLocationRepository,
  );

  const resetFailedPaymentInitialization =
    new ResetFailedPaymentInitializationUseCase(
      cartRepository,
      paymentRepository,
      auditLogService,
      idGenerator,
      logger,
      transactionManager,
      releaseInventoryReservation,
    );

  return {
    cart,
    region,
    cartRepository,
    paymentRepository,
    regionRepository,
    orderRepository,
    transactionRepository,
    notificationOutboxRepository,
    inventoryLocationRepository,
    inventoryLevelRepository,
    inventoryReservationRepository,
    paymentService,
    auditLogService,
    initializePaymentSession,
    verifyPaymentEvent,
    finalizeOrderTransaction,
    resetFailedPaymentInitialization,
    reserveInventory,
    confirmInventoryReservation,
    releaseInventoryReservation,
  };
}