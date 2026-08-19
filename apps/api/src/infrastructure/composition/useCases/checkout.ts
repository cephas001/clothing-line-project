// apps/api/src/infrastructure/composition/useCases/checkout.ts

// Factory for the checkout use cases. Each use case is constructed ONLY when
// all of its dependencies are present; missing dependencies are reported
// rather than faked.
//
// `finalizeOrderTransaction` is the use case the PaymentEventWorker in
// apps/worker consumes; the worker composition root imports this same factory
// output (never a re-construction).

import { CreateOrderRiskAssessmentUseCase } from "@api/use-cases/checkout/CreateOrderRiskAssessmentUseCase";
import { FetchEmbeddedInsuranceQuoteUseCase } from "@api/use-cases/checkout/FetchEmbeddedInsuranceQuoteUseCase";
import { FinalizeOrderTransactionUseCase } from "@api/use-cases/checkout/FinalizeOrderTransactionUseCase";
import { InitializePaymentSessionUseCase } from "@api/use-cases/checkout/InitializePaymentSessionUseCase";
import { ProcessDeadLetterQueueUseCase } from "@api/use-cases/checkout/ProcessDeadLetterQueueUseCase";
import { ProcessFraudAlertEventUseCase } from "@api/use-cases/checkout/ProcessFraudAlertEventUseCase";
import { QueuePaymentEventUseCase } from "@api/use-cases/checkout/QueuePaymentEventUseCase";
import { ReconcileOrphanedLocksUseCase } from "@api/use-cases/checkout/ReconcileOrphanedLocksUseCase";
import { ResetFailedPaymentInitializationUseCase } from "@api/use-cases/checkout/ResetFailedPaymentInitializationUseCase";
import { RetrieveDynamicShippingQuotesUseCase } from "@api/use-cases/checkout/RetrieveDynamicShippingQuotesUseCase";
import { SelectShippingOptionUseCase } from "@api/use-cases/checkout/SelectShippingOptionUseCase";
import { SetCheckoutShippingAddressUseCase } from "@api/use-cases/checkout/SetCheckoutShippingAddressUseCase";
import { VerifyPaymentEventSignatureUseCase } from "@api/use-cases/checkout/VerifyPaymentEventSignatureUseCase";
import { VerifyPaymentEventUseCase } from "@api/use-cases/checkout/VerifyPaymentEventUseCase";
import { ConfirmInventoryReservationUseCase } from "@api/use-cases/inventory/ConfirmInventoryReservationUseCase";
import { ReleaseInventoryReservationUseCase } from "@api/use-cases/inventory/ReleaseInventoryReservationUseCase";
import { ReserveInventoryUseCase } from "@api/use-cases/inventory/ReserveInventoryUseCase";
import type { UseCaseDependencies, UseCaseReportBuilder } from "./types";

export interface CheckoutUseCases {
  createOrderRiskAssessment?: CreateOrderRiskAssessmentUseCase;
  fetchEmbeddedInsuranceQuote?: FetchEmbeddedInsuranceQuoteUseCase;
  finalizeOrderTransaction: FinalizeOrderTransactionUseCase;
  initializePaymentSession?: InitializePaymentSessionUseCase;
  processDeadLetterQueue: ProcessDeadLetterQueueUseCase;
  processFraudAlertEvent?: ProcessFraudAlertEventUseCase;
  queuePaymentEvent: QueuePaymentEventUseCase;
  reconcileOrphanedLocks?: ReconcileOrphanedLocksUseCase;
  resetFailedPaymentInitialization: ResetFailedPaymentInitializationUseCase;
  retrieveDynamicShippingQuotes?: RetrieveDynamicShippingQuotesUseCase;
  selectShippingOption: SelectShippingOptionUseCase;
  setCheckoutShippingAddress?: SetCheckoutShippingAddressUseCase;
  verifyPaymentEvent: VerifyPaymentEventUseCase;
  verifyPaymentEventSignature: VerifyPaymentEventSignatureUseCase;
}

export function buildCheckoutUseCases(
  deps: UseCaseDependencies,
  report: UseCaseReportBuilder,
): CheckoutUseCases {
  const { auditLogService, idGenerator, logger, transactionManager } = deps;

  // The L9 inventory orchestration use cases are re-composed HERE (in addition
  // to their own factory) because the checkout flow orchestrates them directly:
  // InitializePaymentSession reserves atomically inside its obligation-claim
  // unit, FinalizeOrderTransaction confirms inside its order-create unit (and
  // freezes the sourcing snapshot), and ResetFailedPaymentInitialization
  // releases inside its reset unit. Instances are stateless, so the duplication
  // with buildInventoryUseCases is harmless.
  const reserveInventory = new ReserveInventoryUseCase(
    deps.inventoryLocationRepository,
    deps.inventoryLevelRepository,
    deps.inventoryReservationRepository,
    transactionManager,
    auditLogService,
    idGenerator,
    logger,
  );
  const confirmInventoryReservation = new ConfirmInventoryReservationUseCase(
    deps.inventoryLevelRepository,
    deps.inventoryReservationRepository,
    transactionManager,
    auditLogService,
    idGenerator,
    logger,
  );
  const releaseInventoryReservation = new ReleaseInventoryReservationUseCase(
    deps.inventoryLevelRepository,
    deps.inventoryReservationRepository,
    transactionManager,
    auditLogService,
    idGenerator,
    logger,
  );

  const finalizeOrderTransaction = new FinalizeOrderTransactionUseCase(
    deps.orderRepository,
    deps.transactionRepository,
    deps.paymentRepository,
    deps.cartRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
    deps.notificationOutboxRepository,
    confirmInventoryReservation,
    deps.inventoryReservationRepository,
    deps.inventoryLocationRepository,
  );
  const processDeadLetterQueue = new ProcessDeadLetterQueueUseCase(
    deps.queueService,
    auditLogService,
    idGenerator,
    logger,
  );
  const queuePaymentEvent = new QueuePaymentEventUseCase(
    deps.queueService,
    auditLogService,
    idGenerator,
    logger,
  );
  const verifyPaymentEventSignature = new VerifyPaymentEventSignatureUseCase(
    deps.cryptographyService,
    auditLogService,
    idGenerator,
    logger,
  );
  const verifyPaymentEvent = new VerifyPaymentEventUseCase(
    deps.paymentRepository,
    auditLogService,
    idGenerator,
    logger,
  );

  const riskService = deps.externalServices?.riskAssessmentService;
  let createOrderRiskAssessment: CreateOrderRiskAssessmentUseCase | undefined;
  if (riskService) {
    createOrderRiskAssessment = new CreateOrderRiskAssessmentUseCase(
      riskService,
      deps.orderRepository,
      auditLogService,
      idGenerator,
      logger,
    );
  } else {
    report.unwiredUseCase(
      "CreateOrderRiskAssessmentUseCase",
      "IRiskAssessmentService",
    );
  }

  const insuranceService = deps.externalServices?.insuranceService;
  let fetchEmbeddedInsuranceQuote: FetchEmbeddedInsuranceQuoteUseCase | undefined;
  if (insuranceService) {
    fetchEmbeddedInsuranceQuote = new FetchEmbeddedInsuranceQuoteUseCase(
      deps.cartRepository,
      insuranceService,
      auditLogService,
      idGenerator,
      logger,
      transactionManager,
    );
  } else {
    report.unwiredUseCase(
      "FetchEmbeddedInsuranceQuoteUseCase",
      "IInsuranceService",
    );
  }

  const paymentService = deps.externalServices?.paymentService;
  let initializePaymentSession: InitializePaymentSessionUseCase | undefined;
  if (paymentService) {
    initializePaymentSession = new InitializePaymentSessionUseCase(
      deps.cartRepository,
      deps.paymentRepository,
      paymentService,
      auditLogService,
      idGenerator,
      logger,
      transactionManager,
      deps.regionRepository,
      reserveInventory,
    );
  } else {
    report.unwiredUseCase(
      "InitializePaymentSessionUseCase",
      "IPaymentService",
    );
  }

  const logisticsService = deps.externalServices?.logisticsService;
  let processFraudAlertEvent: ProcessFraudAlertEventUseCase | undefined;
  if (logisticsService) {
    processFraudAlertEvent = new ProcessFraudAlertEventUseCase(
      deps.orderRepository,
      deps.fulfillmentRepository,
      logisticsService,
      auditLogService,
      idGenerator,
      logger,
      transactionManager,
    );
  } else {
    report.unwiredUseCase(
      "ProcessFraudAlertEventUseCase",
      "ILogisticsService",
    );
  }

  const databaseManagementService =
    deps.externalServices?.databaseManagementService;
  let reconcileOrphanedLocks: ReconcileOrphanedLocksUseCase | undefined;
  if (databaseManagementService) {
    reconcileOrphanedLocks = new ReconcileOrphanedLocksUseCase(
      databaseManagementService,
      auditLogService,
      idGenerator,
      logger,
    );
  } else {
    report.unwiredUseCase(
      "ReconcileOrphanedLocksUseCase",
      "IDatabaseManagementService",
    );
  }

  let retrieveDynamicShippingQuotes:
    | RetrieveDynamicShippingQuotesUseCase
    | undefined;
  if (logisticsService) {
    retrieveDynamicShippingQuotes = new RetrieveDynamicShippingQuotesUseCase(
      deps.cartRepository,
      logisticsService,
      auditLogService,
      idGenerator,
      logger,
      transactionManager,
    );
  } else {
    report.unwiredUseCase(
      "RetrieveDynamicShippingQuotesUseCase",
      "ILogisticsService",
    );
  }

  // The selection operation depends only on core dependencies (the quote list
  // it resolves against is persisted on the cart by
  // RetrieveDynamicShippingQuotesUseCase), so it is always wired. It refuses to
  // apply a quote that is not in the server-persisted list, and refuses any
  // mutation once a durable payment obligation exists for the cart (the
  // obligation freezes the authoritative amount + shipping snapshot).
  const selectShippingOption = new SelectShippingOptionUseCase(
    deps.cartRepository,
    deps.paymentRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );

  // Releases the shipping/payment mutation lock after a failed/abandoned
  // payment attempt, and releases the checkout inventory reservation anchored
  // on the obligation's deterministic reference back to the available pool.
  // Depends only on core dependencies, so it is always wired.
  const resetFailedPaymentInitialization =
    new ResetFailedPaymentInitializationUseCase(
      deps.cartRepository,
      deps.paymentRepository,
      auditLogService,
      idGenerator,
      logger,
      transactionManager,
      releaseInventoryReservation,
    );

  const taxService = deps.externalServices?.taxCalculationService;
  let setCheckoutShippingAddress: SetCheckoutShippingAddressUseCase | undefined;
  if (taxService) {
    setCheckoutShippingAddress = new SetCheckoutShippingAddressUseCase(
      deps.cartRepository,
      taxService,
      auditLogService,
      idGenerator,
      logger,
      transactionManager,
    );
  } else {
    report.unwiredUseCase(
      "SetCheckoutShippingAddressUseCase",
      "ITaxCalculationService",
    );
  }

  report.wiredUseCases(
    "FinalizeOrderTransactionUseCase",
    "ProcessDeadLetterQueueUseCase",
    "QueuePaymentEventUseCase",
    "ResetFailedPaymentInitializationUseCase",
    "SelectShippingOptionUseCase",
    "VerifyPaymentEventSignatureUseCase",
    "VerifyPaymentEventUseCase",
  );

  return {
    createOrderRiskAssessment,
    fetchEmbeddedInsuranceQuote,
    finalizeOrderTransaction,
    initializePaymentSession,
    processDeadLetterQueue,
    processFraudAlertEvent,
    queuePaymentEvent,
    reconcileOrphanedLocks,
    resetFailedPaymentInitialization,
    retrieveDynamicShippingQuotes,
    selectShippingOption,
    setCheckoutShippingAddress,
    verifyPaymentEvent,
    verifyPaymentEventSignature,
  };
}
