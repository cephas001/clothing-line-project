// apps/api/tests/integration/l7/L7PricingTaxE2E.test.ts
//
// E2E TESTS — the FINAL success criterion for the L7 pricing & tax capability.
//
// The invariant under test:
//   Catalog/Regional Pricing -> Authoritative Pricing -> Promotion -> Tax ->
//   Shipping -> Insurance -> Authoritative Checkout Breakdown -> Durable
//   Payment Obligation -> Paystack -> Historical Snapshot.
//
// This suite drives the ACTUAL L7 use-case pipeline from a bare cart:
//   AddCartLineItemUseCase (regional pricing resolves each line unit price)
//   -> ApplyDiscountCodeUseCase (promotion)
//   -> SetCheckoutShippingAddressUseCase (authoritative tax)
//   -> FetchEmbeddedInsuranceQuoteUseCase (insurance premium)
//   -> server-validated shipping quotes + selection (shipping)
//   -> InitializePaymentSessionUseCase (durable obligation -> Paystack)
//   -> VerifyPaymentEventUseCase (webhook gate)
//   -> FinalizeOrderTransactionUseCase (frozen historical snapshot)
//
// and asserts the equality: Payment.amountMinor == Order.totalAmountMinor ==
// authoritative checkout breakdown total == the EXACT amount the gateway
// received. Mutating prices / promotions / tax / shipping AFTER checkout must
// leave the historical order and the durable obligation unchanged.
//
// A failure-injection case proves the "DB failure AFTER gateway success does
// not recalculate" guarantee: the retry reuses the SAME obligation, reference,
// and frozen amount even though the cart's recomputed total drifted.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { buildCartWithoutShipping, buildCheckoutCart } from "../../fixtures/cartFactory";
import {
  buildFixedPromotion,
  buildPercentagePromotion,
} from "../../fixtures/promotionFactory";
import { buildRegion } from "../../fixtures/regionFactory";
import { Cart } from "@api/domain/entities/Cart";
import { MoneyAmount } from "@api/domain/entities/MoneyAmount";
import { ProductVariant } from "@api/domain/entities/ProductVariant";
import { RegionalPricingService } from "@api/infrastructure/services/RegionalPricingService";
import { RegionalTaxCalculationService } from "@api/infrastructure/services/RegionalTaxCalculationService";
import { AddCartLineItemUseCase } from "@api/use-cases/cart/AddCartLineItemUseCase";
import { ApplyDiscountCodeUseCase } from "@api/use-cases/cart/ApplyDiscountCodeUseCase";
import { SetCheckoutShippingAddressUseCase } from "@api/use-cases/checkout/SetCheckoutShippingAddressUseCase";
import { FetchEmbeddedInsuranceQuoteUseCase } from "@api/use-cases/checkout/FetchEmbeddedInsuranceQuoteUseCase";
import { createPaymentHarness } from "../payment/harness";
import { InMemoryCartRepository } from "../../fakes/InMemoryCartRepository";
import { InMemoryRegionRepository } from "../../fakes/InMemoryRegionRepository";
import { InMemoryMoneyAmountRepository } from "../../fakes/InMemoryMoneyAmountRepository";
import { InMemoryVariantRepository } from "../../fakes/InMemoryVariantRepository";
import { InMemoryPromotionRepository } from "../../fakes/InMemoryPromotionRepository";
import { InMemoryPaymentRepository } from "../../fakes/InMemoryPaymentRepository";
import { InMemoryOrderRepository } from "../../fakes/InMemoryOrderRepository";
import { InMemoryTransactionRepository } from "../../fakes/InMemoryTransactionRepository";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { InMemoryTransactionManager } from "../../fakes/InMemoryTransactionManager";
import { SnapshotTransactionManager } from "../../fakes/SnapshotTransactionManager";
import { SequenceIdGenerator } from "../../fakes/SequenceIdGenerator";
import { NoopLogger } from "../../fakes/NoopLogger";
import { RepositoryErrorCode } from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { IInsuranceService } from "@api/domain/interfaces/services/IInsuranceService";
import type { ShippingQuote } from "@api/domain/shared/contracts";
import type { JsonObject } from "@api/domain/shared/json";

// The authoritative total for the whole chain:
//   subtotal 60000 (2x25000 + 1x10000) - discount 5000 + tax 4500
//   (60000 @ 750 bps) + shipping 2500 + insurance 500 = 62500.
const AUTHORITATIVE_TOTAL = 62500;

const ADDRESS: JsonObject = {
  firstName: "Ada",
  lastName: "Okafor",
  line1: "1 Marina Street",
  city: "Lagos",
  state: "Lagos",
  postalCode: "101001",
  countryCode: "NG",
  phone: "+2348000000000",
};

const QUOTE: ShippingQuote = {
  id: "quote-1",
  serviceLevel: "Express",
  amountMinor: 2500,
  currency: "ngn",
  etaDays: 3,
  courierId: "courier-1",
  serviceCode: "SC-EXPRESS",
  requestToken: "request-token-1",
};

class StubInsuranceService implements IInsuranceService {
  constructor(private readonly premium: number) {}
  async getQuote(_cartTotalMinor: number): Promise<number> {
    return this.premium;
  }
}

function buildVariant(id: string, sku: string): ProductVariant {
  return new ProductVariant({
    id,
    productId: "product-1",
    sku,
    inventoryQuantity: 100,
    allowBackorder: false,
  });
}

function seedPrice(
  repo: InMemoryMoneyAmountRepository,
  variantId: string,
  regionId: string,
  amountMinor: number,
): void {
  repo.seed(
    new MoneyAmount({
      id: `ma-${variantId}-${regionId}`,
      variantId,
      regionId,
      amountMinor,
    }),
  );
}

interface L7Harness {
  cartRepository: InMemoryCartRepository;
  moneyAmountRepository: InMemoryMoneyAmountRepository;
  promotionRepository: InMemoryPromotionRepository;
  variantRepository: InMemoryVariantRepository;
  regionRepository: InMemoryRegionRepository;
  addCartLineItem: AddCartLineItemUseCase;
  applyDiscountCode: ApplyDiscountCodeUseCase;
  setShippingAddress: SetCheckoutShippingAddressUseCase;
  fetchInsuranceQuote: FetchEmbeddedInsuranceQuoteUseCase;
}

/** A bare, region-bound cart with NO items, quotes, tax, insurance or promotion. */
function buildBareCart(): Cart {
  return buildCartWithoutShipping({
    id: "cart-1",
    items: [],
    promotion: null,
    taxAmountMinor: null,
    insuranceAmountMinor: null,
  });
}

function buildL7Harness(): L7Harness {
  const cartRepository = new InMemoryCartRepository();
  cartRepository.seed(buildBareCart());

  const variantRepository = new InMemoryVariantRepository();
  variantRepository.seed(buildVariant("variant-1", "SKU-1"));
  variantRepository.seed(buildVariant("variant-2", "SKU-2"));

  const moneyAmountRepository = new InMemoryMoneyAmountRepository();
  seedPrice(moneyAmountRepository, "variant-1", "region-ng", 25000);
  seedPrice(moneyAmountRepository, "variant-2", "region-ng", 10000);

  const regionRepository = new InMemoryRegionRepository();
  regionRepository.seed(buildRegion({ id: "region-ng", taxRate: 750 }));

  const promotionRepository = new InMemoryPromotionRepository();
  promotionRepository.seed(buildFixedPromotion("SAVE5K", 5000));

  const auditLogService = new InMemoryAuditLogService();
  const logger = new NoopLogger();
  const tx = new InMemoryTransactionManager();

  const addCartLineItem = new AddCartLineItemUseCase(
    cartRepository,
    variantRepository,
    new RegionalPricingService(moneyAmountRepository),
    auditLogService,
    new SequenceIdGenerator(),
    logger,
    tx,
  );

  const applyDiscountCode = new ApplyDiscountCodeUseCase(
    cartRepository,
    promotionRepository,
    auditLogService,
    logger,
    tx,
  );

  const setShippingAddress = new SetCheckoutShippingAddressUseCase(
    cartRepository,
    new RegionalTaxCalculationService(regionRepository),
    auditLogService,
    new SequenceIdGenerator(),
    logger,
    tx,
  );

  const fetchInsuranceQuote = new FetchEmbeddedInsuranceQuoteUseCase(
    cartRepository,
    new StubInsuranceService(500),
    auditLogService,
    new SequenceIdGenerator(),
    logger,
    tx,
  );

  return {
    cartRepository,
    moneyAmountRepository,
    promotionRepository,
    variantRepository,
    regionRepository,
    addCartLineItem,
    applyDiscountCode,
    setShippingAddress,
    fetchInsuranceQuote,
  };
}

/**
 * Drive the L7 checkout pipeline on the bare cart through every real use case,
 * ending with the server-validated shipping quote + selection. Returns the
 * payment-ready cart.
 */
async function driveCheckoutChain(h: L7Harness): Promise<Cart> {
  await h.addCartLineItem.execute({
    cartId: "cart-1",
    variantId: "variant-1",
    quantity: 2,
    actorId: "customer-1",
  });
  await h.addCartLineItem.execute({
    cartId: "cart-1",
    variantId: "variant-2",
    quantity: 1,
    actorId: "customer-1",
  });
  await h.applyDiscountCode.execute({
    cartId: "cart-1",
    code: "SAVE5K",
    actorId: "customer-1",
  });
  await h.setShippingAddress.execute({
    cartId: "cart-1",
    shippingAddress: ADDRESS,
  });
  await h.fetchInsuranceQuote.execute({ cartId: "cart-1" });

  const cart = (await h.cartRepository.findById("cart-1"))!;
  cart.recordShippingQuotes([QUOTE]);
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
  await h.cartRepository.save(cart);
  return cart;
}

/** "Today's config changed" after checkout: higher prices, bigger discount, higher tax/shipping. */
function buildDriftedCart(id = "cart-1"): Cart {
  return buildCheckoutCart({
    id,
    customerId: "customer-1",
    email: "buyer@example.com",
    items: [
      { id: "line-1", variantId: "variant-1", quantity: 2, unitPriceMinor: 35000, title: "Classic Tee" },
      { id: "line-2", variantId: "variant-2", quantity: 1, unitPriceMinor: 20000, title: "Canvas Belt" },
    ],
    promotion: buildPercentagePromotion("SAVE10", 1000),
    taxAmountMinor: 6000,
    shippingAmountMinor: 4000,
    insuranceAmountMinor: 0,
  });
}

describe("L7 full chain — pricing -> promotion -> tax -> shipping -> insurance -> obligation -> order", () => {
  it("freezes ONE authoritative total: Payment.amountMinor == Order.total == checkout total == gateway amount", async () => {
    const h = buildL7Harness();
    const cart = await driveCheckoutChain(h);

    // The server-authoritative breakdown built from the L7 components.
    expect(cart.computeAuthoritativeCheckoutBreakdown()).toEqual({
      subtotalMinor: 60000,
      discountMinor: 5000,
      taxMinor: 4500,
      shippingMinor: 2500,
      insuranceMinor: 500,
      totalMinor: AUTHORITATIVE_TOTAL,
    });

    const ph = createPaymentHarness({
      cart,
      cartRepository: h.cartRepository,
      region: buildRegion({ id: "region-ng", taxRate: 750 }),
    });

    const result = await ph.initializePaymentSession.execute({ cartId: "cart-1" });
    expect(result.reference).toBe("CLP-checkout-cart-1");

    // Durable obligation freezes the authoritative total and every component.
    const obligation = await ph.paymentRepository.findByReference("CLP-checkout-cart-1");
    expect(obligation!.amountMinor).toBe(AUTHORITATIVE_TOTAL);
    expect(obligation!.currency).toBe("ngn");
    expect(obligation!.breakdown).toEqual({
      subtotalMinor: 60000,
      discountMinor: 5000,
      taxMinor: 4500,
      shippingMinor: 2500,
      insuranceMinor: 500,
      totalMinor: AUTHORITATIVE_TOTAL,
    });
    // The charged line items are frozen at the REGIONAL prices resolved at add time.
    expect(
      (obligation!.metadata as Record<string, unknown>).lineItems,
    ).toEqual([
      { id: "id-1", variantId: "variant-1", quantity: 2, unitPriceMinor: 25000, title: null },
      { id: "id-2", variantId: "variant-2", quantity: 1, unitPriceMinor: 10000, title: null },
    ]);

    // Paystack receives EXACTLY the frozen obligation values — never a recompute.
    expect(ph.paymentService.checkoutInitializations).toHaveLength(1);
    expect(ph.paymentService.checkoutInitializations[0].amountMinor).toBe(AUTHORITATIVE_TOTAL);
    expect(ph.paymentService.checkoutInitializations[0].currency).toBe("ngn");
    expect(ph.paymentService.checkoutInitializations[0].reference).toBe("CLP-checkout-cart-1");

    // The webhook gate validates the FROZEN amount; an off-by-one is rejected.
    await expect(() =>
      ph.verifyPaymentEvent.execute({
        cartId: "cart-1",
        transactionReference: "CLP-checkout-cart-1",
        amountPaidMinor: AUTHORITATIVE_TOTAL,
        reportedCurrency: "ngn",
      }),
    ).resolves();
    await expect(() =>
      ph.verifyPaymentEvent.execute({
        cartId: "cart-1",
        transactionReference: "CLP-checkout-cart-1",
        amountPaidMinor: AUTHORITATIVE_TOTAL + 1,
        reportedCurrency: "ngn",
      }),
    ).rejectsWithCode("INVALID_PAYMENT_AMOUNT");

    // Finalized order = the frozen snapshot.
    const order = await ph.finalizeOrderTransaction.execute({
      cartId: "cart-1",
      transactionReference: "CLP-checkout-cart-1",
      amountPaidMinor: AUTHORITATIVE_TOTAL,
      currency: "ngn",
      expectedAmountMinor: AUTHORITATIVE_TOTAL,
      actorId: "system",
    });
    expect(order.transactionReference).toBe("CLP-checkout-cart-1");
    expect(order.totalAmountMinor).toBe(AUTHORITATIVE_TOTAL);
    expect(order.subtotalMinor).toBe(60000);
    expect(order.discountMinor).toBe(5000);
    expect(order.taxMinor).toBe(4500);
    expect(order.shippingMinor).toBe(2500);
    expect(order.insuranceMinor).toBe(500);
    expect(order.currency).toBe("ngn");

    // THE FINAL INVARIANT: payment == order == authoritative checkout total.
    expect(obligation!.amountMinor).toBe(order.totalAmountMinor);
    expect(order.totalAmountMinor).toBe(
      cart.computeAuthoritativeCheckoutBreakdown().totalMinor,
    );
  });

  it("mutating prices / promotion / tax / shipping after checkout leaves the historical order and obligation unchanged", async () => {
    const h = buildL7Harness();
    const cart = await driveCheckoutChain(h);
    const ph = createPaymentHarness({
      cart,
      cartRepository: h.cartRepository,
      region: buildRegion({ id: "region-ng", taxRate: 750 }),
    });

    await ph.initializePaymentSession.execute({ cartId: "cart-1" });
    const order = await ph.finalizeOrderTransaction.execute({
      cartId: "cart-1",
      transactionReference: "CLP-checkout-cart-1",
      amountPaidMinor: AUTHORITATIVE_TOTAL,
      currency: "ngn",
      expectedAmountMinor: AUTHORITATIVE_TOTAL,
      actorId: "system",
    });
    const obligation = await ph.paymentRepository.findByReference("CLP-checkout-cart-1");
    expect(order.totalAmountMinor).toBe(AUTHORITATIVE_TOTAL);

    // --- Today's config drifts AFTER checkout, across every L7 surface -------
    // 1. Catalog/regional pricing: variant-1 is re-priced to 35000 (the
    //    production upsert keys on (variant_id, region_id), so the stored row
    //    is updated in place).
    (await h.moneyAmountRepository.findRegionalPrice("variant-1", "region-ng"))!.updateAmount(35000);
    expect(await h.moneyAmountRepository.findRegionalPrice("variant-1", "region-ng")).not.toBeNull();

    // 2. Promotion config: SAVE5K is deactivated.
    h.promotionRepository.seed(buildFixedPromotion("SAVE5K", 5000, { isActive: false }));

    // 3. Tax rate: the region now charges 2000 bps (20%).
    ph.regionRepository.seed(buildRegion({ id: "region-ng", taxRate: 2000 }));

    // 4. Shipping/insurance/discount: the cart itself is re-priced (91000).
    ph.cartRepository.seed(buildDriftedCart("cart-1"));
    const drifted = await ph.cartRepository.findById("cart-1");
    expect(drifted!.computeAuthoritativeCheckoutBreakdown().totalMinor).toBe(91000);

    // The historical ORDER keeps the frozen snapshot, never a reconstruction.
    expect(order.totalAmountMinor).toBe(AUTHORITATIVE_TOTAL);
    expect(order.subtotalMinor).toBe(60000);
    expect(order.discountMinor).toBe(5000);
    expect(order.taxMinor).toBe(4500);
    expect(order.shippingMinor).toBe(2500);
    expect(order.insuranceMinor).toBe(500);

    // The durable OBLIGATION is equally frozen.
    expect(obligation!.amountMinor).toBe(AUTHORITATIVE_TOTAL);
    expect(obligation!.breakdown.totalMinor).toBe(AUTHORITATIVE_TOTAL);
    expect(
      (obligation!.metadata as Record<string, unknown>).lineItems,
    ).toEqual([
      { id: "id-1", variantId: "variant-1", quantity: 2, unitPriceMinor: 25000, title: null },
      { id: "id-2", variantId: "variant-2", quantity: 1, unitPriceMinor: 10000, title: null },
    ]);

    // The webhook still validates the FROZEN amount; today's recomputed 91000
    // is rejected — the customer was never asked to pay it.
    await expect(() =>
      ph.verifyPaymentEvent.execute({
        cartId: "cart-1",
        transactionReference: "CLP-checkout-cart-1",
        amountPaidMinor: AUTHORITATIVE_TOTAL,
        reportedCurrency: "ngn",
      }),
    ).resolves();
    await expect(() =>
      ph.verifyPaymentEvent.execute({
        cartId: "cart-1",
        transactionReference: "CLP-checkout-cart-1",
        amountPaidMinor: 91000,
        reportedCurrency: "ngn",
      }),
    ).rejectsWithCode("INVALID_PAYMENT_AMOUNT");
  });
});

describe("L7 failure injection — DB failure AFTER gateway success does not recalculate", () => {
  it("a retry reuses the SAME obligation, reference, and frozen amount despite a drifted cart", async () => {
    const h = buildL7Harness();
    const cart = await driveCheckoutChain(h);

    const paymentRepository = new InMemoryPaymentRepository();
    const orderRepository = new InMemoryOrderRepository();
    const transactionRepository = new InMemoryTransactionRepository();
    const transactionManager = new SnapshotTransactionManager([
      h.cartRepository,
      paymentRepository,
      orderRepository,
      transactionRepository,
    ]);
    const ph = createPaymentHarness({
      cart,
      cartRepository: h.cartRepository,
      paymentRepository,
      orderRepository,
      transactionRepository,
      transactionManager,
      region: buildRegion({ id: "region-ng", taxRate: 750 }),
    });

    // Phase A — gateway down. The claim unit of work commits the durable
    // `initialization_pending` obligation and the gateway call fails: this is
    // the exact durable baseline a rollback must return to.
    ph.paymentService.failWith = new Error("upstream gateway 500");
    await expect(() =>
      ph.initializePaymentSession.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("EXTERNAL_SERVICE_ERROR");
    const pendingBaseline = await ph.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    expect(pendingBaseline!.status).toBe("initialization_pending");
    expect(pendingBaseline!.amountMinor).toBe(AUTHORITATIVE_TOTAL);
    expect(ph.paymentService.checkoutInitializations).toHaveLength(1);

    // Capture the TRUE durable state before the persist attempt.
    const paymentBefore = ph.paymentRepository.snapshot();
    const cartBefore = h.cartRepository.snapshot();

    // Phase B — the gateway recovers and returns success, but the SECOND unit
    // of work (persisting the initialized payment + the cart mirror) fails on
    // the DB. The whole unit of work rolls back; the durable truth is still
    // the claim-committed pending obligation.
    ph.paymentService.failWith = undefined;
    ph.cartRepository.failNextSaveWith = RepositoryErrorCode.CONNECTION;
    await expect(() =>
      ph.initializePaymentSession.execute({ cartId: "cart-1" }),
    ).rejectsWithCode("INTERNAL_ERROR");

    // Restore the persist unit of work the way a real DB rollback would.
    ph.paymentRepository.restore(paymentBefore);
    h.cartRepository.restore(cartBefore);

    const rolledBack = await ph.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    expect(rolledBack!.status).toBe("initialization_pending");
    expect(rolledBack!.providerReference).toBeNull();
    const cartAfterFailure = await h.cartRepository.findById("cart-1");
    expect(cartAfterFailure!.isPaymentInitialized()).toBe(false);
    expect(ph.paymentRepository.all).toHaveLength(1);

    // Today's config drifts: prices, promotion, tax and shipping all change;
    // the cart's recomputed total is now 91000.
    (await h.moneyAmountRepository.findRegionalPrice("variant-1", "region-ng"))!.updateAmount(35000);
    ph.regionRepository.seed(buildRegion({ id: "region-ng", taxRate: 2000 }));
    ph.cartRepository.seed(buildDriftedCart("cart-1"));
    const drifted = await ph.cartRepository.findById("cart-1");
    expect(drifted!.computeAuthoritativeCheckoutBreakdown().totalMinor).toBe(91000);

    // Retry: SAME reference, SAME frozen obligation amount — the initialization
    // NEVER recalculates the amount from the drifted cart. Paystack saw the
    // SAME idempotency key on every attempt.
    const retry = await ph.initializePaymentSession.execute({ cartId: "cart-1" });
    expect(retry.reference).toBe("CLP-checkout-cart-1");
    expect(ph.paymentService.checkoutInitializations).toHaveLength(3);
    expect(
      ph.paymentService.checkoutInitializations.map((o) => o.amountMinor),
    ).toEqual([
      AUTHORITATIVE_TOTAL,
      AUTHORITATIVE_TOTAL,
      AUTHORITATIVE_TOTAL,
    ]);
    expect(
      ph.paymentService.checkoutInitializations.map((o) => o.reference),
    ).toEqual([
      "CLP-checkout-cart-1",
      "CLP-checkout-cart-1",
      "CLP-checkout-cart-1",
    ]);

    const settled = await ph.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    expect(settled!.status).toBe("initialized");
    expect(settled!.amountMinor).toBe(AUTHORITATIVE_TOTAL);
    expect(ph.paymentRepository.all).toHaveLength(1);
  });
});