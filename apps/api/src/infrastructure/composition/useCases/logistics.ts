// apps/api/src/infrastructure/composition/useCases/logistics.ts

// Factory for the logistics use cases. Each use case is constructed ONLY when
// all of its dependencies are present; missing dependencies are reported
// rather than faked.
//
// NOTE: ProcessCourierTrackingEventUseCase (the consumer the
// LogisticsEventWorker routes tracking events through) is always wired — it
// depends only on repositories/core dependencies. Its notification service is
// OPTIONAL and injected only when a concrete INotificationService is supplied;
// without one, customer notifications are skipped (best-effort) and the use
// case still persists fulfillment state.

import { ConfirmOrderEditUseCase } from "@api/use-cases/logistics/ConfirmOrderEditUseCase";
import { DetermineSourcingLocationUseCase } from "@api/use-cases/logistics/DetermineSourcingLocationUseCase";
import { DispatchOrderFulfillmentUseCase } from "@api/use-cases/logistics/DispatchOrderFulfillmentUseCase";
import { FinalizeSwapTransactionUseCase } from "@api/use-cases/logistics/FinalizeSwapTransactionUseCase";
import { GenerateDraftOrderUseCase } from "@api/use-cases/logistics/GenerateDraftOrderUseCase";
import { InitiateReturnAuthorizationUseCase } from "@api/use-cases/logistics/InitiateReturnAuthorizationUseCase";
import { ProcessCourierTrackingEventUseCase } from "@api/use-cases/logistics/ProcessCourierTrackingEventUseCase";
import { ProcessOrderSwapVarianceUseCase } from "@api/use-cases/logistics/ProcessOrderSwapVarianceUseCase";
import { ProposeOrderEditUseCase } from "@api/use-cases/logistics/ProposeOrderEditUseCase";
import { QueueLogisticsEventUseCase } from "@api/use-cases/logistics/QueueLogisticsEventUseCase";
import { VerifyLogisticsEventSignatureUseCase } from "@api/use-cases/logistics/VerifyLogisticsEventSignatureUseCase";
import { VerifySwapPaymentEventUseCase } from "@api/use-cases/logistics/VerifySwapPaymentEventUseCase";
import type { UseCaseDependencies, UseCaseReportBuilder } from "./types";

export interface LogisticsUseCases {
  confirmOrderEdit: ConfirmOrderEditUseCase;
  determineSourcingLocation?: DetermineSourcingLocationUseCase;
  dispatchOrderFulfillment?: DispatchOrderFulfillmentUseCase;
  finalizeSwapTransaction: FinalizeSwapTransactionUseCase;
  generateDraftOrder?: GenerateDraftOrderUseCase;
  initiateReturnAuthorization?: InitiateReturnAuthorizationUseCase;
  processCourierTrackingEvent: ProcessCourierTrackingEventUseCase;
  processOrderSwapVariance?: ProcessOrderSwapVarianceUseCase;
  proposeOrderEdit: ProposeOrderEditUseCase;
  queueLogisticsEvent: QueueLogisticsEventUseCase;
  verifyLogisticsEventSignature: VerifyLogisticsEventSignatureUseCase;
  verifySwapPaymentEvent: VerifySwapPaymentEventUseCase;
}

export function buildLogisticsUseCases(
  deps: UseCaseDependencies,
  report: UseCaseReportBuilder,
): LogisticsUseCases {
  const { auditLogService, idGenerator, logger, transactionManager } = deps;

  const confirmOrderEdit = new ConfirmOrderEditUseCase(
    deps.orderEditRepository,
    deps.orderRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );
  const proposeOrderEdit = new ProposeOrderEditUseCase(
    deps.orderRepository,
    deps.orderEditRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );

  const inventoryLocationService =
    deps.externalServices?.inventoryLocationService;
  let determineSourcingLocation: DetermineSourcingLocationUseCase | undefined;
  if (inventoryLocationService) {
    determineSourcingLocation = new DetermineSourcingLocationUseCase(
      inventoryLocationService,
      auditLogService,
      idGenerator,
      logger,
    );
  } else {
    report.unwiredUseCase(
      "DetermineSourcingLocationUseCase",
      "IInventoryLocationService",
    );
  }

  const logisticsService = deps.externalServices?.logisticsService;
  let dispatchOrderFulfillment: DispatchOrderFulfillmentUseCase | undefined;
  if (logisticsService) {
    dispatchOrderFulfillment = new DispatchOrderFulfillmentUseCase(
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
      "DispatchOrderFulfillmentUseCase",
      "ILogisticsService",
    );
  }

  const notificationService = deps.externalServices?.notificationService;
  let generateDraftOrder: GenerateDraftOrderUseCase | undefined;
  if (notificationService) {
    generateDraftOrder = new GenerateDraftOrderUseCase(
      deps.draftOrderRepository,
      notificationService,
      auditLogService,
      idGenerator,
      logger,
      transactionManager,
    );
  } else {
    report.unwiredUseCase("GenerateDraftOrderUseCase", "INotificationService");
  }

  let initiateReturnAuthorization:
    | InitiateReturnAuthorizationUseCase
    | undefined;
  if (logisticsService) {
    initiateReturnAuthorization = new InitiateReturnAuthorizationUseCase(
      deps.orderRepository,
      deps.returnRepository,
      logisticsService,
      auditLogService,
      idGenerator,
      logger,
      transactionManager,
    );
  } else {
    report.unwiredUseCase(
      "InitiateReturnAuthorizationUseCase",
      "ILogisticsService",
    );
  }

  const paymentService = deps.externalServices?.paymentService;
  let processOrderSwapVariance: ProcessOrderSwapVarianceUseCase | undefined;
  if (paymentService) {
    processOrderSwapVariance = new ProcessOrderSwapVarianceUseCase(
      deps.orderRepository,
      deps.cartRepository,
      deps.swapRepository,
      deps.paymentRepository,
      deps.refundRepository,
      paymentService,
      auditLogService,
      idGenerator,
      logger,
      transactionManager,
      deps.customerRepository,
      deps.moneyAmountRepository,
    );
  } else {
    report.unwiredUseCase(
      "ProcessOrderSwapVarianceUseCase",
      "IPaymentService",
    );
  }

  // --- Swap payment verification + atomic finalization (worker-side) ---------
  // These only depend on repositories + IAuditLogService, so they are always
  // wired. The PaymentEventWorker consumes them for swap obligations.
  const verifySwapPaymentEvent = new VerifySwapPaymentEventUseCase(
    deps.paymentRepository,
    deps.swapRepository,
    auditLogService,
    idGenerator,
    logger,
  );

  // --- Courier tracking event consumer (L5 worker) ---------------------------
  // Always wired: it resolves fulfillment by providerShipmentId, applies the
  // courier tracking + dispatch state machines, and persists via
  // ITransactionManager. The notification service is OPTIONAL — absent, the
  // customer notification is skipped (best-effort) and fulfillment state is
  // still persisted.
  const processCourierTrackingEvent = new ProcessCourierTrackingEventUseCase(
    deps.fulfillmentRepository,
    transactionManager,
    auditLogService,
    idGenerator,
    logger,
    deps.externalServices?.notificationService,
  );

  // --- Logistics webhook pipeline (L5): signature verification + queueing ----
  // These only depend on core dependencies (cryptography, queue, audit, id,
  // logger), so they are always wired. The HTTP router mounts only when
  // SHIPBUBBLE_WEBHOOK_SECRET is configured; the queue itself carries only the
  // provider-neutral event (no secrets, no raw bodies).
  const verifyLogisticsEventSignature =
    new VerifyLogisticsEventSignatureUseCase(
      deps.cryptographyService,
      auditLogService,
      idGenerator,
      logger,
    );
  const queueLogisticsEvent = new QueueLogisticsEventUseCase(
    deps.queueService,
    auditLogService,
    idGenerator,
    logger,
  );
  const finalizeSwapTransaction = new FinalizeSwapTransactionUseCase(
    deps.swapRepository,
    deps.orderRepository,
    deps.paymentRepository,
    deps.transactionRepository,
    deps.variantRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );

  report.wiredUseCases(
    "ConfirmOrderEditUseCase",
    "ProposeOrderEditUseCase",
    "VerifySwapPaymentEventUseCase",
    "FinalizeSwapTransactionUseCase",
    "VerifyLogisticsEventSignatureUseCase",
    "QueueLogisticsEventUseCase",
    "ProcessCourierTrackingEventUseCase",
  );

  return {
    confirmOrderEdit,
    determineSourcingLocation,
    dispatchOrderFulfillment,
    finalizeSwapTransaction,
    generateDraftOrder,
    initiateReturnAuthorization,
    processCourierTrackingEvent,
    processOrderSwapVariance,
    proposeOrderEdit,
    queueLogisticsEvent,
    verifyLogisticsEventSignature,
    verifySwapPaymentEvent,
  };
}
