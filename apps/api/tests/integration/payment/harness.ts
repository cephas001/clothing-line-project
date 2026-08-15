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
import type { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { InitializePaymentSessionUseCase } from "@api/use-cases/checkout/InitializePaymentSessionUseCase";
import { VerifyPaymentEventUseCase } from "@api/use-cases/checkout/VerifyPaymentEventUseCase";
import { FinalizeOrderTransactionUseCase } from "@api/use-cases/checkout/FinalizeOrderTransactionUseCase";
import { ResetFailedPaymentInitializationUseCase } from "@api/use-cases/checkout/ResetFailedPaymentInitializationUseCase";
import { InMemoryCartRepository } from "../../fakes/InMemoryCartRepository";
import { InMemoryRegionRepository } from "../../fakes/InMemoryRegionRepository";
import { InMemoryPaymentRepository } from "../../fakes/InMemoryPaymentRepository";
import { InMemoryOrderRepository } from "../../fakes/InMemoryOrderRepository";
import { InMemoryTransactionRepository } from "../../fakes/InMemoryTransactionRepository";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { InMemoryTransactionManager } from "../../fakes/InMemoryTransactionManager";
import { FakePaymentService } from "../../fakes/FakePaymentService";
import { SequenceIdGenerator } from "../../fakes/SequenceIdGenerator";
import { NoopLogger } from "../../fakes/NoopLogger";
import { buildCheckoutCart } from "../../fixtures/cartFactory";
import { buildRegion } from "../../fixtures/regionFactory";
import { buildFixedPromotion } from "../../fixtures/promotionFactory";

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
}

export interface PaymentHarness {
  cart: Cart;
  region: Region;
  cartRepository: InMemoryCartRepository;
  paymentRepository: InMemoryPaymentRepository;
  regionRepository: InMemoryRegionRepository;
  orderRepository: InMemoryOrderRepository;
  transactionRepository: InMemoryTransactionRepository;
  paymentService: FakePaymentService;
  auditLogService: InMemoryAuditLogService;
  initializePaymentSession: InitializePaymentSessionUseCase;
  verifyPaymentEvent: VerifyPaymentEventUseCase;
  finalizeOrderTransaction: FinalizeOrderTransactionUseCase;
  resetFailedPaymentInitialization: ResetFailedPaymentInitializationUseCase;
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

  const paymentService = new FakePaymentService();
  const auditLogService = new InMemoryAuditLogService();
  const idGenerator = new SequenceIdGenerator();
  const logger = new NoopLogger();
  const transactionManager =
    options.transactionManager ?? new InMemoryTransactionManager();

  const initializePaymentSession = new InitializePaymentSessionUseCase(
    cartRepository,
    paymentRepository,
    paymentService,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
    regionRepository,
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
  );

  const resetFailedPaymentInitialization =
    new ResetFailedPaymentInitializationUseCase(
      cartRepository,
      paymentRepository,
      auditLogService,
      idGenerator,
      logger,
      transactionManager,
    );

  return {
    cart,
    region,
    cartRepository,
    paymentRepository,
    regionRepository,
    orderRepository,
    transactionRepository,
    paymentService,
    auditLogService,
    initializePaymentSession,
    verifyPaymentEvent,
    finalizeOrderTransaction,
    resetFailedPaymentInitialization,
  };
}