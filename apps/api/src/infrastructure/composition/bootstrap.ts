// apps/api/src/infrastructure/composition/bootstrap.ts

// The application's composition root: the ONLY place that knows both the
// domain/application abstractions and their concrete infrastructure
// implementations. It owns:
//   1. configuration (infrastructure/composition/config.ts),
//   2. construction of every concrete infrastructure service + repository,
//   3. wiring of use cases,
//   4. graceful shutdown in dependency order (queue -> db -> redis).
//
// The HTTP runtime does NOT compose background workers anymore: they moved to
// apps/worker (@clothing-line-project/worker), whose composition root imports
// the shared factories below (config/infrastructure/repositories/useCases) and
// composes the workers there.
//
// Unwired capabilities are REPORTED, never faked:
//   - IAuditLogService is implemented by PostgresAuditLogService (constructed
//     in buildInfrastructure) and injected into every use case that needs it.
//     An optional `auditLogService` override may be supplied to
//     bootstrapApplication({ auditLogService }) and replaces the default.
//   - External service adapters (payment, logistics, notification, ...) are
//     optional; when supplied, the use cases that need them are constructed.
//     The Paystack payment adapter is built here by default whenever
//     PAYSTACK_SECRET_KEY is present (fails at construction without it), and
//     remains overridable via `externalServices.paymentService`.

import type { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { loadAppConfig } from "./config";
import {
  buildInfrastructure,
  disposeInfrastructure,
  InfrastructureDependencies,
} from "./infrastructure";
import { buildRepositories, Repositories } from "./repositories";
import { CachedProductReadRepository } from "../caching/CachedProductReadRepository";
import {
  InvalidatingMoneyAmountRepository,
  InvalidatingProductRepository,
  InvalidatingVariantRepository,
} from "../caching/InvalidatingCatalogRepositories";
import { ProductReadCacheInvalidator } from "../caching/ProductReadCacheInvalidator";
import { buildUseCases, UseCaseComposition } from "./useCases";
import type { ExternalServiceDependencies } from "./useCases/types";
import { useCaseReportLines } from "./useCases/types";
import { PaystackPaymentService } from "../services/PaystackPaymentService";
import { PaystackWebhookPayloadMapper } from "../services/PaystackWebhookPayloadMapper";
import { ShipbubbleLogisticsService } from "../services/ShipbubbleLogisticsService";
import { ShipbubbleWebhookPayloadMapper } from "../services/ShipbubbleWebhookPayloadMapper";
import { buildNotificationService } from "./notificationService";
import { RegionalPricingService } from "../services/RegionalPricingService";
import { RegionalTaxCalculationService } from "../services/RegionalTaxCalculationService";
import {
  createAdminRouter,
  createAuthRouter,
  createCartRouter,
  createCatalogRouter,
  createCheckoutShippingRouter,
  createCourierTrackingWebhookRouter,
  createCustomersRouter,
  createOrdersRouter,
  createPaymentInitializationRouter,
  createPaymentWebhookRouter,
  createShipbubbleWebhookRouter,
  createSwapRouter,
} from "../../adapters/http";
import { CourierTrackingWebhookPayloadMapper } from "../services/CourierTrackingWebhookPayloadMapper";
import type { Router } from "express";

export interface BootstrapOptions {
  /**
   * Optional IAuditLogService override. Defaults to the concrete
   * PostgresAuditLogService constructed by buildInfrastructure; supply a
   * different implementation only to replace the default (e.g. in tests).
   */
  auditLogService?: IAuditLogService;
  /** External service adapters; use cases that need them light up when present. */
  externalServices?: ExternalServiceDependencies;
}

export interface ApplicationRuntime {
  config: ReturnType<typeof loadAppConfig>;
  infrastructure: InfrastructureDependencies;
  repositories: Repositories;
  useCases: UseCaseComposition;
  /**
   * Payment webhook HTTP router, present only when PAYSTACK_WEBHOOK_SECRET is
   * configured. The API server mounts it at /store/payments/webhook.
   */
  paymentWebhookRouter?: Router;
  /**
   * Payment-initialization HTTP router (POST /store/carts/:id/payment-sessions),
   * present only when the payment service is configured (InitializePaymentSessionUseCase
   * is wired). Pure transport boundary — the use case owns all checkout/pricing logic.
   */
  paymentInitializationRouter?: Router;
  /**
   * Swap-payment HTTP router (POST /store/orders/:orderId/swaps), present only
   * when the payment service is configured (ProcessOrderSwapVarianceUseCase is
   * wired). Pure transport boundary — the use case owns all swap/pricing logic.
   */
  swapRouter?: Router;
  /**
   * Checkout-shipping HTTP router (POST /store/carts/:id/shipping-quotes and
   * POST /store/carts/:id/shipping-options). Always present (selection depends
   * only on core dependencies); the shipping-quotes route is registered only
   * when a logistics service is configured. Pure transport boundary — the use
   * cases own all quote/selection/pricing logic.
   */
  checkoutShippingRouter?: Router;
  /**
   * Storefront authentication router (POST /store/auth and
   * POST /store/customers/logout). Always present: both use cases depend only
   * on core dependencies. Pure transport boundary — the use cases own
   * credential verification and session revocation.
   */
  authRouter: Router;
  /**
   * Storefront catalogue router (browse/search/details/related/reviews/
   * availability/categories). Always present; routes whose use case is unwired
   * (no search service, recommendation engine, or pricing service) are not
   * registered and return 404 — they are never faked.
   */
  catalogRouter: Router;
  /**
   * Shipbubble logistics webhook HTTP router, present only when
   * SHIPBUBBLE_WEBHOOK_SECRET is configured. The API server mounts it at
   * /store/webhooks/shipbubble. Pure transport boundary: verify signature ->
   * map provider event -> enqueue. Never mutates fulfillment, never creates
   * shipments, never calls Shipbubble, and never opens a DB transaction.
   */
  logisticsWebhookRouter?: Router;
  /**
   * Courier-tracking webhook HTTP router (POST /store/webhooks/courier-tracking),
   * present only when COURIER_TRACKING_WEBHOOK_SECRET is configured. Pure
   * transport boundary: verify signature (raw bytes) -> parse + map provider
   * event -> enqueue. It never updates fulfillment, never creates shipments,
   * and never holds a DB transaction (L5 LOGISTICS CRITICAL).
   */
  courierTrackingWebhookRouter?: Router;
  /**
   * Cart HTTP router (mounted at /store/carts). Always present; the variant
   * line-item + shipping-address routes are registered only when the
   * corresponding use case is wired (pricing/tax service configured).
   */
  cartRouter: Router;
  /**
   * Customer HTTP router (mounted at /store). Always present; the
   * password-reset/initiate route is registered only when the notification
   * service is configured (unwired -> 404, never faked).
   */
  customersRouter: Router;
  /**
   * Order HTTP router (mounted at /store). Always present; the returns and
   * fulfillments routes are registered only when the logistics service is
   * configured (unwired -> 404, never faked).
   */
  ordersRouter: Router;
  /**
   * Admin HTTP router (mounted at /admin). Always present: every admin use case
   * depends only on core dependencies.
   */
  adminRouter: Router;
  /**
   * Graceful shutdown: close the queue connections, the Postgres pool, and the
   * session-revocation Redis client. Background workers are not owned by this
   * runtime (see apps/worker). Idempotent.
   */
  shutdown(): Promise<void>;
  /** Human-readable startup/wiring summary for the bootstrap log. */
  describe(): string;
}

export function bootstrapApplication(
  options: BootstrapOptions = {},
): ApplicationRuntime {
  const config = loadAppConfig();
  const infrastructure = buildInfrastructure(config, { component: "api" });
  const repositories = buildRepositories(infrastructure.transactionContext);
  const logger = infrastructure.logger;

  // --- Product read cache (L9 Part 2/3): read-through decorator + invalidation -
  // Read side: wraps the Postgres-backed IProductReadRepository with the
  // versioned, fail-open, TTL-bounded cache. Postgres stays the source of
  // truth; the cache only short-circuits identical read contexts. Redis
  // failures are logged and the request falls back to Postgres. The shared
  // ioredis client is reused (no second connection).
  //
  // Write side: every catalog/pricing/inventory mutation that reaches these
  // three repositories (product, variant, moneyAmount) bumps the read cache
  // GENERATION (ProductReadCacheInvalidator) — O(1), no key scans/deletes, and
  // fail-open so a Redis hiccup can never fail a write. Reservation and
  // checkout flows never write these repositories, so high-frequency inventory
  // movement can never thrash the cache. The worker runtime composes
  // repositories directly and is deliberately NOT wrapped (no worker catalog
  // writes exist today; BulkCatalogImportWorker has no processor wired).
  const invalidator = new ProductReadCacheInvalidator({
    redis: infrastructure.redis,
    logger,
  });
  repositories.productReadRepository = new CachedProductReadRepository({
    source: repositories.productReadRepository,
    redis: infrastructure.redis,
    logger,
    ttlSeconds: config.productCacheTtlSeconds,
  });
  repositories.productRepository = new InvalidatingProductRepository(
    repositories.productRepository,
    invalidator,
  );
  repositories.variantRepository = new InvalidatingVariantRepository(
    repositories.variantRepository,
    invalidator,
  );
  repositories.moneyAmountRepository = new InvalidatingMoneyAmountRepository(
    repositories.moneyAmountRepository,
    invalidator,
  );

  // --- External services: default Paystack adapter when a secret is present ----
  // The Paystack adapter is infrastructure-only (never queries repositories);
  // constructing it here keeps it out of the worker runtime (which never needs
  // IPaymentService and must not require PAYSTACK_SECRET_KEY). An explicit
  // `externalServices.paymentService` override wins over the default.
  const externalServices: ExternalServiceDependencies = {
    ...options.externalServices,
  };
  if (!externalServices.paymentService && config.paystackSecretKey) {
    externalServices.paymentService = new PaystackPaymentService({
      secretKey: config.paystackSecretKey,
      baseUrl: config.paystackBaseUrl,
      timeoutMs: config.paystackTimeoutMs,
      logger,
    });
  }

  // --- Logistics adapter (Shipbubble) when the API key is present -------------
  // Constructed only when the credential is present; fails fast when the
  // provider-required sender address or package category is missing, so an
  // incomplete logistics configuration can never start with a half-built
  // adapter. ShipbubbleLogisticsService is infrastructure-only (never queries
  // repositories); it stays out of the worker runtime, which passes no
  // externalServices and never needs ILogisticsService. An explicit
  // `externalServices.logisticsService` override wins over the default.
  if (!externalServices.logisticsService && config.shipbubbleApiKey) {
    if (!config.shipbubbleSenderAddress || !config.shipbubblePackageCategoryId) {
      throw new Error(
        "SHIPBUBBLE_API_KEY is set but SHIPBUBBLE_SENDER_ADDRESS / SHIPBUBBLE_PACKAGE_CATEGORY_ID are not; the Shipbubble adapter cannot be constructed.",
      );
    }
    externalServices.logisticsService = new ShipbubbleLogisticsService({
      apiKey: config.shipbubbleApiKey,
      baseUrl: config.shipbubbleBaseUrl,
      timeoutMs: config.shipbubbleTimeoutMs,
      logger,
      senderAddress: config.shipbubbleSenderAddress,
      packageCategoryId: config.shipbubblePackageCategoryId,
      defaultItemWeightKg: config.shipbubbleDefaultItemWeightKg,
      defaultPackageDimensions: config.shipbubbleDefaultPackageDimensions,
    });
  }

  // --- Notification adapter (Resend) when the API key is present -------------
  // Constructed ONLY via the shared infrastructure/composition factory; fails
  // fast when the required sender address is missing, so an incomplete
  // notification configuration can never start with a half-built adapter. The
  // adapter is infrastructure-only (never queries repositories, never enqueues,
  // never mutates business state); recipient-preference suppression happens
  // inside it BEFORE any provider call. An explicit
  // `externalServices.notificationService` override wins over the default.
  if (!externalServices.notificationService) {
    externalServices.notificationService = buildNotificationService(
      config,
      logger,
    );
  }

  // --- Pricing & tax services (L7): DB-backed, provider-neutral ---------------
  // Constructed unconditionally: they resolve authoritative pricing and tax
  // from repositories (MoneyAmount + Region), require no secrets, and never
  // contact external providers. Explicit overrides win over the defaults so
  // tests can substitute fakes. Wiring them lights up AddCartLineItemUseCase,
  // GetVariantAvailabilityUseCase, and SetCheckoutShippingAddressUseCase.
  if (!externalServices.pricingService) {
    externalServices.pricingService = new RegionalPricingService(
      repositories.moneyAmountRepository,
    );
  }
  if (!externalServices.taxCalculationService) {
    externalServices.taxCalculationService = new RegionalTaxCalculationService(
      repositories.regionRepository,
    );
  }

  // --- Use cases: every use case receives the concrete IAuditLogService -------
  const auditLogService = options.auditLogService ?? infrastructure.auditLogService;
  const useCases = buildUseCases(
    {
      ...repositories,
      logger: infrastructure.logger,
      idGenerator: infrastructure.idGenerator,
      auditLogService,
      transactionManager: infrastructure.transactionManager,
      queueService: infrastructure.queueService,
      hashingService: infrastructure.hashingService,
      tokenService: infrastructure.tokenService,
      sessionRevocationService: infrastructure.sessionRevocationService,
      cryptographyService: infrastructure.cryptographyService,
      externalServices,
    },
    { runtime: "api" },
  );
  logger.info("Use cases composed", {
    runtime: "api",
    wired: useCases.report.summary.wired,
    unavailableMissingInfrastructure:
      useCases.report.summary.unavailableMissingInfrastructure,
    unavailableMissingConfiguration:
      useCases.report.summary.unavailableMissingConfiguration,
    deferredByDesign: useCases.report.summary.deferredByDesign,
  });

  // --- Payment webhook HTTP adapter (Phase 6/7) --------------------------------
  // Mounted ONLY when the dedicated PAYSTACK_WEBHOOK_SECRET is present. The
  // webhook secret is DISTINCT from PAYSTACK_SECRET_KEY — the API secret key is
  // never used for signature verification. When absent the endpoint is not
  // mounted (requests receive a 404); it is never faked or silently weakened.
  // The mapper resolves the local payment obligation by reference, so it needs
  // the payment repository (the established payment reference mapping).
  const paystackWebhookMapper = new PaystackWebhookPayloadMapper({
    paymentRepository: repositories.paymentRepository,
  });
  let paymentWebhookRouter: Router | undefined;
  if (config.paystackWebhookSecret) {
    paymentWebhookRouter = createPaymentWebhookRouter({
      verifySignature: useCases.useCases.checkout.verifyPaymentEventSignature,
      queuePaymentEvent: useCases.useCases.checkout.queuePaymentEvent,
      mapper: paystackWebhookMapper,
      webhookSecret: config.paystackWebhookSecret,
      logger,
    });
  }

  // --- Shipbubble logistics webhook HTTP adapter (L5) --------------------------
  // Mounted ONLY when the dedicated SHIPBUBBLE_WEBHOOK_SECRET is present. The
  // secret is DISTINCT from SHIPBUBBLE_API_KEY — the API key is never used for
  // signature verification. When absent the endpoint is not mounted (requests
  // receive a 404); it is never faked or silently weakened. The mapper is a
  // pure provider-boundary transformation (no repositories), and the router
  // only verifies -> maps -> enqueues; it never touches PostgreSQL or BullMQ
  // inside a transaction.
  const shipbubbleWebhookMapper = new ShipbubbleWebhookPayloadMapper();
  let logisticsWebhookRouter: Router | undefined;
  if (config.shipbubbleWebhookSecret) {
    logisticsWebhookRouter = createShipbubbleWebhookRouter({
      verifySignature: useCases.useCases.logistics.verifyLogisticsEventSignature,
      queueLogisticsEvent: useCases.useCases.logistics.queueLogisticsEvent,
      mapper: shipbubbleWebhookMapper,
      webhookSecret: config.shipbubbleWebhookSecret,
      logger,
    });
  }

  // --- Payment-initialization HTTP adapter (Phase 1/2) -------------------------
  // Mounted ONLY when InitializePaymentSessionUseCase is wired (i.e. a payment
  // service is configured). Pure transport boundary: it maps the request into
  // the use case input, resolves the optional bearer identity, and shapes the
  // application-level response. Never finalizes, captures, or trusts client
  // payment status.
  const initializePaymentSession =
    useCases.useCases.checkout.initializePaymentSession;
  let paymentInitializationRouter: Router | undefined;
  if (initializePaymentSession) {
    paymentInitializationRouter = createPaymentInitializationRouter({
      initializePaymentSession,
      tokenService: infrastructure.tokenService,
      logger,
    });
  }

  // --- Swap-payment HTTP adapter (Phase 3) -----------------------------------
  // Mounted ONLY when ProcessOrderSwapVarianceUseCase is wired (i.e. a payment
  // service is configured). Pure transport boundary: it maps the request into
  // the use case input, resolves the optional bearer identity, and shapes the
  // application-level response. The client never supplies a financial value;
  // the use case resolves the authoritative replacement price and creates the
  // durable obligation BEFORE the gateway is contacted. Never finalizes a swap
  // or trusts client payment status.
  const processOrderSwapVariance =
    useCases.useCases.logistics.processOrderSwapVariance;
  let swapRouter: Router | undefined;
  if (processOrderSwapVariance) {
    swapRouter = createSwapRouter({
      processOrderSwapVariance,
      tokenService: infrastructure.tokenService,
      logger,
    });
  }

  // --- Checkout-shipping HTTP adapter (L3) -----------------------------------
  // Selection depends only on core dependencies (SelectShippingOptionUseCase is
  // always wired), so the router is always constructed; the shipping-quotes
  // route is registered only when a logistics service is configured (the use
  // case is wired), and requests otherwise receive a 404 — it is never faked.
  const retrieveDynamicShippingQuotes =
    useCases.useCases.checkout.retrieveDynamicShippingQuotes;
  const selectShippingOption = useCases.useCases.checkout.selectShippingOption;
  const checkoutShippingRouter = createCheckoutShippingRouter({
    retrieveDynamicShippingQuotes,
    selectShippingOption,
    tokenService: infrastructure.tokenService,
    logger,
  });

  // --- Storefront auth HTTP adapter (API-L1) ------------------------------
  // Always constructed: AuthenticateCustomerUseCase and
  // RevokeCustomerSessionUseCase depend only on core dependencies. Pure
  // transport boundary: strict {email,password}/{reason} bodies, bearer-token
  // identity from the shared auth helper, and the use cases own credential
  // verification + denylist revocation.
  const authRouter = createAuthRouter({
    authenticateCustomer: useCases.useCases.customers.authenticateCustomer,
    revokeCustomerSession: useCases.useCases.customers.revokeCustomerSession,
    tokenService: infrastructure.tokenService,
    logger,
  });

  // --- Storefront catalogue HTTP adapter (API-L1) -------------------------
  // Always constructed; the search / related-products / availability routes are
  // registered only when the corresponding use case is wired (external
  // service present). Pure transport boundary: query/header parsing only.
  const catalogRouter = createCatalogRouter({
    browseCatalog: useCases.useCases.catalog.browseCatalog,
    getProductDetails: useCases.useCases.catalog.getProductDetails,
    retrieveCategoryTree: useCases.useCases.catalog.retrieveCategoryTree,
    submitProductReview: useCases.useCases.catalog.submitProductReview,
    searchProducts: useCases.useCases.catalog.searchProducts,
    resolveCrossSellingProducts:
      useCases.useCases.catalog.resolveCrossSellingProducts,
    getVariantAvailability: useCases.useCases.catalog.getVariantAvailability,
    tokenService: infrastructure.tokenService,
    logger,
  });

  // --- Courier-tracking webhook HTTP adapter (L5) -----------------------------
  // Mounted ONLY when the dedicated COURIER_TRACKING_WEBHOOK_SECRET is present
  // (a production webhook signing secret is never defaulted). The secret is
  // DISTINCT from any API key. The router is a TRANSPORT boundary:
  // verify signature (HMAC-SHA512 over the RAW bytes, BEFORE JSON parsing) ->
  // parse + map -> enqueue. It never updates fulfillment, never creates
  // shipments, and never opens a DB transaction — the LogisticsEventWorker
  // reconciles state later, idempotently by deterministic event key. When the
  // secret is absent the endpoint is not mounted (requests receive a 404); it
  // is never faked or silently weakened.
  const courierTrackingWebhookMapper = new CourierTrackingWebhookPayloadMapper();
  let courierTrackingWebhookRouter: Router | undefined;
  if (config.courierTrackingWebhookSecret) {
    courierTrackingWebhookRouter = createCourierTrackingWebhookRouter({
      verifySignature:
        useCases.useCases.logistics.verifyLogisticsEventSignature,
      queueLogisticsEvent: useCases.useCases.logistics.queueLogisticsEvent,
      mapper: courierTrackingWebhookMapper,
      webhookSecret: config.courierTrackingWebhookSecret,
      logger,
    });
  }

  // --- Cart HTTP adapter (API-L1 / F3) --------------------------------------
  // Always constructed; the variant line-item route is registered only when the
  // pricing service is configured (AddCartLineItemUseCase wired) and the
  // shipping-address route only when the tax service is configured
  // (SetCheckoutShippingAddressUseCase wired). Pure transport boundary.
  const cartRouter = createCartRouter({
    initializeCartSession: useCases.useCases.cart.initializeCartSession,
    getCart: useCases.useCases.cart.getCart,
    addCartLineItem: useCases.useCases.cart.addCartLineItem,
    addCustomLineItem: useCases.useCases.cart.addCustomLineItem,
    updateLineItemQuantity: useCases.useCases.cart.updateLineItemQuantity,
    removeCartLineItem: useCases.useCases.cart.removeCartLineItem,
    applyDiscountCode: useCases.useCases.cart.applyDiscountCode,
    mergeGuestCartToCustomer: useCases.useCases.cart.mergeGuestCartToCustomer,
    setCheckoutShippingAddress:
      useCases.useCases.checkout.setCheckoutShippingAddress,
    tokenService: infrastructure.tokenService,
    logger,
  });

  // --- Customer HTTP adapter (API-L1 / F3) ----------------------------------
  // Always constructed; the password-reset/initiate route is registered only
  // when the notification service is configured (InitiatePasswordResetUseCase
  // wired; otherwise 404, never faked). Pure transport boundary.
  const customersRouter = createCustomersRouter({
    registerCustomerAccount: useCases.useCases.customers.registerCustomerAccount,
    getCustomerProfile: useCases.useCases.customers.getCustomerProfile,
    getCustomerAddresses: useCases.useCases.customers.getCustomerAddresses,
    initiatePasswordReset: useCases.useCases.customers.initiatePasswordReset,
    completePasswordReset: useCases.useCases.customers.completePasswordReset,
    manageAddressBook: useCases.useCases.customers.manageAddressBook,
    manageB2BBusinessUnit: useCases.useCases.customers.manageB2BBusinessUnit,
    requestQuote: useCases.useCases.customers.requestQuote,
    approveB2BQuote: useCases.useCases.customers.approveB2BQuote,
    retrieveOrderHistory: useCases.useCases.customers.retrieveOrderHistory,
    processCustomerDataErasure:
      useCases.useCases.customers.processCustomerDataErasure,
    tokenService: infrastructure.tokenService,
    logger,
  });

  // --- Order HTTP adapter (API-L1 / F3) -------------------------------------
  // Always constructed; the returns and fulfillments routes are registered only
  // when the logistics service is configured (unwired -> 404, never faked).
  // Pure transport boundary.
  const ordersRouter = createOrdersRouter({
    getOrder: useCases.useCases.logistics.getOrder,
    initiateReturnAuthorization:
      useCases.useCases.logistics.initiateReturnAuthorization,
    proposeOrderEdit: useCases.useCases.logistics.proposeOrderEdit,
    confirmOrderEdit: useCases.useCases.logistics.confirmOrderEdit,
    dispatchOrderFulfillment:
      useCases.useCases.logistics.dispatchOrderFulfillment,
    tokenService: infrastructure.tokenService,
    logger,
  });

  // --- Admin HTTP adapter (API-L1 / F3) -------------------------------------
  // Always constructed: every admin use case depends only on core
  // dependencies. Pure transport boundary.
  const adminRouter = createAdminRouter({
    createProduct: useCases.useCases.admin.createProduct,
    createProductVariant: useCases.useCases.admin.createProductVariant,
    configureRegionalPricing:
      useCases.useCases.admin.configureRegionalPricing,
    createPromotionRule: useCases.useCases.admin.createPromotionRule,
    createSalesChannel: useCases.useCases.admin.createSalesChannel,
    manageCategories: useCases.useCases.admin.manageCategories,
    manageAdminRolePermissions:
      useCases.useCases.admin.manageAdminRolePermissions,
    importBulkCatalogData: useCases.useCases.admin.importBulkCatalogData,
    listDeadLetterJobs: useCases.useCases.admin.listDeadLetterJobs,
    retryDeadLetterJob: useCases.useCases.admin.retryDeadLetterJob,
    generateDraftOrder: useCases.useCases.logistics.generateDraftOrder,
    determineSourcingLocation:
      useCases.useCases.inventory.determineSourcingLocation,
    pruneAbandonedCarts: useCases.useCases.cart.pruneAbandonedCarts,
    tokenService: infrastructure.tokenService,
    logger,
  });

  let shutDown = false;

  const runtime: ApplicationRuntime = {
    config,
    infrastructure,
    repositories,
    useCases,
    paymentWebhookRouter,
    paymentInitializationRouter,
    swapRouter,
    checkoutShippingRouter,
    logisticsWebhookRouter,
    courierTrackingWebhookRouter,
    cartRouter,
    customersRouter,
    ordersRouter,
    adminRouter,
    authRouter,
    catalogRouter,

    async shutdown(): Promise<void> {
      if (shutDown) {
        return;
      }
      shutDown = true;
      await disposeInfrastructure(infrastructure);
      logger.info("Application shut down cleanly");
    },

    describe(): string {
      const lines: string[] = [];
      lines.push(`Port: ${config.port}`);
      lines.push(`Redis: ${config.redisUrl}`);
      lines.push("");
      lines.push(...useCaseReportLines(useCases.report));
      lines.push("");
      lines.push(
        paymentWebhookRouter
          ? "Payment webhook: mounted (/store/payments/webhook)"
          : "Payment webhook: NOT mounted (PAYSTACK_WEBHOOK_SECRET not set)",
      );
      lines.push(
        paymentInitializationRouter
          ? "Payment initialization: mounted (/store/carts/:id/payment-sessions)"
          : "Payment initialization: NOT mounted (payment service not configured)",
      );
      lines.push(
        swapRouter
          ? "Swap payment: mounted (/store/orders/:orderId/swaps)"
          : "Swap payment: NOT mounted (payment service not configured)",
      );
      lines.push(
        retrieveDynamicShippingQuotes
          ? "Checkout shipping: mounted (/store/carts/:id/shipping-quotes, /store/carts/:id/shipping-options)"
          : "Checkout shipping: shipping-options mounted; shipping-quotes NOT mounted (logistics service not configured)",
      );
      lines.push(
        logisticsWebhookRouter
          ? "Shipbubble webhook: mounted (/store/webhooks/shipbubble)"
          : "Shipbubble webhook: NOT mounted (SHIPBUBBLE_WEBHOOK_SECRET not set)",
      );
      lines.push(
        courierTrackingWebhookRouter
          ? "Courier-tracking webhook: mounted (/store/webhooks/courier-tracking)"
          : "Courier-tracking webhook: NOT mounted (COURIER_TRACKING_WEBHOOK_SECRET not set)",
      );
      lines.push("Cart: mounted (/store/carts)");
      lines.push("Customers: mounted (/store)");
      lines.push("Orders: mounted (/store/orders, /store/order-edits)");
      lines.push(
        `Admin: mounted (/admin/products, /admin/promotions, /admin/sales-channels, /admin/categories, /admin/draft-orders, /admin/sourcing-location, /admin/carts/prune, /admin/imports, /admin/queues/${
          useCases.useCases.admin.adjustInventoryLevel ? "+ /admin/variants/:id/inventory" : ""
        })`,
      );
      lines.push("Auth: mounted (/store/auth, /store/customers/logout)");
      lines.push(
        `Catalogue: mounted (/store/products, /store/products/:id, /store/product-categories, /store/products/:id/reviews)${
          useCases.useCases.catalog.searchProducts
            ? " + /store/products/search"
            : ""
        }${
          useCases.useCases.catalog.resolveCrossSellingProducts
            ? " + /store/products/:id/related"
            : ""
        }${
          useCases.useCases.catalog.getVariantAvailability
            ? " + /store/variants/:id/availability"
            : ""
        }`,
      );
      lines.push(
        externalServices.logisticsService
          ? "Logistics (Shipbubble): wired"
          : "Logistics (Shipbubble): NOT wired (SHIPBUBBLE_API_KEY not set)",
      );
      lines.push(
        externalServices.pricingService
          ? "Pricing (regional): wired"
          : "Pricing (regional): NOT wired",
      );
      lines.push(
        externalServices.taxCalculationService
          ? "Tax (regional): wired"
          : "Tax (regional): NOT wired",
      );
      lines.push(
        externalServices.notificationService
          ? "Notifications (Resend): wired"
          : "Notifications (Resend): NOT wired (NOTIFICATION_API_KEY not set)",
      );
      lines.push(
        `Product read cache: Redis (TTL ${config.productCacheTtlSeconds}s, generation-bump invalidation on product/variant/pricing writes)`,
      );
      return lines.map((line) => (line === "" ? line : `  ${line}`)).join("\n");
    },
  };

  return runtime;
}
