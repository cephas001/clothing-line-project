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
import { buildUseCases, UseCaseComposition } from "./useCases";
import type { ExternalServiceDependencies } from "./useCases/types";
import { PaystackPaymentService } from "../services/PaystackPaymentService";
import { PaystackWebhookPayloadMapper } from "../services/PaystackWebhookPayloadMapper";
import { ShipbubbleLogisticsService } from "../services/ShipbubbleLogisticsService";
import { ShipbubbleWebhookPayloadMapper } from "../services/ShipbubbleWebhookPayloadMapper";
import { createPaymentWebhookRouter } from "../../adapters/http/PaymentWebhookRouter";
import { createShipbubbleWebhookRouter } from "../../adapters/http/ShipbubbleWebhookRouter";
import { createPaymentInitializationRouter } from "../../adapters/http/PaymentInitializationRouter";
import { createSwapRouter } from "../../adapters/http/SwapRouter";
import { createCheckoutShippingRouter } from "../../adapters/http/CheckoutShippingRouter";
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
   * Shipbubble logistics webhook HTTP router, present only when
   * SHIPBUBBLE_WEBHOOK_SECRET is configured. The API server mounts it at
   * /store/webhooks/shipbubble. Pure transport boundary: verify signature ->
   * map provider event -> enqueue. Never mutates fulfillment, never creates
   * shipments, never calls Shipbubble, and never opens a DB transaction.
   */
  logisticsWebhookRouter?: Router;
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
  const infrastructure = buildInfrastructure(config);
  const repositories = buildRepositories(infrastructure.transactionContext);
  const logger = infrastructure.logger;

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

  // --- Use cases: every use case receives the concrete IAuditLogService -------
  const auditLogService = options.auditLogService ?? infrastructure.auditLogService;
  const useCases = buildUseCases({
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
  });
  logger.info("Use cases composed", {
    wired: useCases.report.wired.length,
    unwired: useCases.report.unwired.length,
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
      lines.push(
        `Use cases: ${useCases.report.wired.length} wired, ` +
          `${useCases.report.unwired.length} unwired`,
      );
      for (const u of useCases.report.unwired) {
        lines.push(`  unwired: ${u.useCase} (missing ${u.missingDependency})`);
      }
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
        externalServices.logisticsService
          ? "Logistics (Shipbubble): wired"
          : "Logistics (Shipbubble): NOT wired (SHIPBUBBLE_API_KEY not set)",
      );
      return lines.join("\n");
    },
  };

  return runtime;
}
