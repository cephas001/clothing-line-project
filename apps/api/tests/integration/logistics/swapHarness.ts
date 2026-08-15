// apps/api/tests/integration/logistics/swapHarness.ts
//
// Shared composition harness for the L6 swap/refund INTEGRATION suite. Wires
// the in-memory fakes exactly as the real composition root wires
// infrastructure, and exposes the three use cases that form the swap
// financial lifecycle:
//
//   ProcessOrderSwapVarianceUseCase   -> upcharge / even exchange / refund
//   VerifySwapPaymentEventUseCase     -> swap upcharge verification gate
//   FinalizeSwapTransactionUseCase    -> idempotent swap finalization
//
// Every test seeds a finalized order + its captured payment, a cart (for the
// authoritative regional price), the customer, and the inventory, then drives
// the use cases through the interface contracts. No HTTP, no Postgres, no
// Paystack — the financial invariants are exercised at the application
// boundary.

import { Cart } from "@api/domain/entities/Cart";
import { Customer } from "@api/domain/entities/Customer";
import { MoneyAmount } from "@api/domain/entities/MoneyAmount";
import { Order } from "@api/domain/entities/Order";
import { Payment } from "@api/domain/entities/Payment";
import { ProductVariant } from "@api/domain/entities/ProductVariant";
import type { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { ProcessOrderSwapVarianceUseCase } from "@api/use-cases/logistics/ProcessOrderSwapVarianceUseCase";
import { VerifySwapPaymentEventUseCase } from "@api/use-cases/logistics/VerifySwapPaymentEventUseCase";
import { FinalizeSwapTransactionUseCase } from "@api/use-cases/logistics/FinalizeSwapTransactionUseCase";
import { InMemoryOrderRepository } from "../../fakes/InMemoryOrderRepository";
import { InMemoryCartRepository } from "../../fakes/InMemoryCartRepository";
import { InMemorySwapRepository } from "../../fakes/InMemorySwapRepository";
import { InMemoryPaymentRepository } from "../../fakes/InMemoryPaymentRepository";
import { InMemoryRefundRepository } from "../../fakes/InMemoryRefundRepository";
import { InMemoryVariantRepository } from "../../fakes/InMemoryVariantRepository";
import { InMemoryCustomerRepository } from "../../fakes/InMemoryCustomerRepository";
import { InMemoryMoneyAmountRepository } from "../../fakes/InMemoryMoneyAmountRepository";
import { InMemoryTransactionRepository } from "../../fakes/InMemoryTransactionRepository";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { InMemoryTransactionManager } from "../../fakes/InMemoryTransactionManager";
import { FakePaymentService } from "../../fakes/FakePaymentService";
import { SequenceIdGenerator } from "../../fakes/SequenceIdGenerator";
import { NoopLogger } from "../../fakes/NoopLogger";
import { buildCheckoutCart } from "../../fixtures/cartFactory";
import {
  buildSwapOrder,
  buildCapturedPayment,
  SWAP_CART_ID,
  SWAP_CUSTOMER_ID,
  SWAP_ORDER_ID,
} from "../../fixtures/orderFactory";

/** The canonical replacement variant id the swap flows swap INTO. */
export const REPLACEMENT_VARIANT_ID = "variant-9";

export interface SwapHarnessOptions {
  order?: Order;
  cart?: Cart;
  capturedPayment?: Payment;
  capturedAmountMinor?: number;
  customer?: Customer;
  /** Inventory for the returned variant (variant-1). Default 10. */
  returnedVariantInventory?: number;
  /** Inventory for the replacement variant (variant-9). Default 10. */
  replacementVariantInventory?: number;
  transactionManager?: ITransactionManager;
}

export interface SwapHarness {
  order: Order;
  cart: Cart;
  customer: Customer;
  returnedVariant: ProductVariant;
  replacementVariant: ProductVariant;
  orderRepository: InMemoryOrderRepository;
  cartRepository: InMemoryCartRepository;
  swapRepository: InMemorySwapRepository;
  paymentRepository: InMemoryPaymentRepository;
  refundRepository: InMemoryRefundRepository;
  variantRepository: InMemoryVariantRepository;
  customerRepository: InMemoryCustomerRepository;
  moneyAmountRepository: InMemoryMoneyAmountRepository;
  transactionRepository: InMemoryTransactionRepository;
  paymentService: FakePaymentService;
  auditLogService: InMemoryAuditLogService;
  processOrderSwapVariance: ProcessOrderSwapVarianceUseCase;
  verifySwapPaymentEvent: VerifySwapPaymentEventUseCase;
  finalizeSwapTransaction: FinalizeSwapTransactionUseCase;
}

/** Set the authoritative regional price for the replacement variant. */
export function seedReplacementPrice(
  h: SwapHarness,
  amountMinor: number,
): void {
  h.moneyAmountRepository.seed(
    new MoneyAmount({
      id: "price-variant-9",
      variantId: REPLACEMENT_VARIANT_ID,
      regionId: "region-ng",
      amountMinor,
    }),
  );
}

export function createSwapHarness(options: SwapHarnessOptions = {}): SwapHarness {
  const order = options.order ?? buildSwapOrder();
  const cart = options.cart ?? buildCheckoutCart({ id: SWAP_CART_ID });
  const customer =
    options.customer ??
    new Customer({
      id: SWAP_CUSTOMER_ID,
      firstName: "Ada",
      lastName: "Okafor",
      email: "buyer@example.com",
    });
  const capturedPayment =
    options.capturedPayment ??
    buildCapturedPayment({ capturedAmountMinor: options.capturedAmountMinor });

  const returnedVariant = new ProductVariant({
    id: "variant-1",
    productId: "product-1",
    sku: "SKU-TEE",
    inventoryQuantity: options.returnedVariantInventory ?? 10,
    allowBackorder: false,
  });
  const replacementVariant = new ProductVariant({
    id: REPLACEMENT_VARIANT_ID,
    productId: "product-2",
    sku: "SKU-SWAP",
    inventoryQuantity: options.replacementVariantInventory ?? 10,
    allowBackorder: false,
  });

  const orderRepository = new InMemoryOrderRepository();
  orderRepository.seed(order);
  const cartRepository = new InMemoryCartRepository();
  cartRepository.seed(cart);
  const swapRepository = new InMemorySwapRepository();
  const paymentRepository = new InMemoryPaymentRepository();
  paymentRepository.seed(capturedPayment);
  const refundRepository = new InMemoryRefundRepository();
  const variantRepository = new InMemoryVariantRepository();
  variantRepository.seed(returnedVariant);
  variantRepository.seed(replacementVariant);
  const customerRepository = new InMemoryCustomerRepository();
  customerRepository.seed(customer);
  const moneyAmountRepository = new InMemoryMoneyAmountRepository();
  const transactionRepository = new InMemoryTransactionRepository();

  const paymentService = new FakePaymentService();
  const auditLogService = new InMemoryAuditLogService();
  const idGenerator = new SequenceIdGenerator();
  const logger = new NoopLogger();
  const transactionManager =
    options.transactionManager ?? new InMemoryTransactionManager();

  const processOrderSwapVariance = new ProcessOrderSwapVarianceUseCase(
    orderRepository,
    cartRepository,
    swapRepository,
    paymentRepository,
    refundRepository,
    paymentService,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
    customerRepository,
    moneyAmountRepository,
  );

  const verifySwapPaymentEvent = new VerifySwapPaymentEventUseCase(
    paymentRepository,
    swapRepository,
    auditLogService,
    idGenerator,
    logger,
  );

  const finalizeSwapTransaction = new FinalizeSwapTransactionUseCase(
    swapRepository,
    orderRepository,
    paymentRepository,
    transactionRepository,
    variantRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );

  return {
    order,
    cart,
    customer,
    returnedVariant,
    replacementVariant,
    orderRepository,
    cartRepository,
    swapRepository,
    paymentRepository,
    refundRepository,
    variantRepository,
    customerRepository,
    moneyAmountRepository,
    transactionRepository,
    paymentService,
    auditLogService,
    processOrderSwapVariance,
    verifySwapPaymentEvent,
    finalizeSwapTransaction,
  };
}