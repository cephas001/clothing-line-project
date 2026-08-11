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
import { ReserveInventoryPessimisticUseCase } from "@api/use-cases/checkout/ReserveInventoryPessimisticUseCase";
import { RetrieveDynamicShippingQuotesUseCase } from "@api/use-cases/checkout/RetrieveDynamicShippingQuotesUseCase";
import { SetCheckoutShippingAddressUseCase } from "@api/use-cases/checkout/SetCheckoutShippingAddressUseCase";
import { VerifyPaymentEventSignatureUseCase } from "@api/use-cases/checkout/VerifyPaymentEventSignatureUseCase";
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
  reserveInventoryPessimistic: ReserveInventoryPessimisticUseCase;
  retrieveDynamicShippingQuotes?: RetrieveDynamicShippingQuotesUseCase;
  setCheckoutShippingAddress?: SetCheckoutShippingAddressUseCase;
  verifyPaymentEventSignature: VerifyPaymentEventSignatureUseCase;
}

export function buildCheckoutUseCases(
  deps: UseCaseDependencies,
  report: UseCaseReportBuilder,
): CheckoutUseCases {
  const { auditLogService, idGenerator, logger, transactionManager } = deps;

  const finalizeOrderTransaction = new FinalizeOrderTransactionUseCase(
    deps.orderRepository,
    deps.transactionRepository,
    deps.cartRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
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
  const reserveInventoryPessimistic = new ReserveInventoryPessimisticUseCase(
    deps.variantRepository,
    transactionManager,
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
      paymentService,
      auditLogService,
      idGenerator,
      logger,
      transactionManager,
      deps.regionRepository,
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
    );
  } else {
    report.unwiredUseCase(
      "RetrieveDynamicShippingQuotesUseCase",
      "ILogisticsService",
    );
  }

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
    "ReserveInventoryPessimisticUseCase",
    "VerifyPaymentEventSignatureUseCase",
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
    reserveInventoryPessimistic,
    retrieveDynamicShippingQuotes,
    setCheckoutShippingAddress,
    verifyPaymentEventSignature,
  };
}
