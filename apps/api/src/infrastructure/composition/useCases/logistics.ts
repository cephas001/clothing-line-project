// apps/api/src/infrastructure/composition/useCases/logistics.ts

// Factory for the logistics use cases. Each use case is constructed ONLY when
// all of its dependencies are present; missing dependencies are reported
// rather than faked.
//
// NOTE: ProcessCourierTrackingEventUseCase (the consumer the
// LogisticsEventWorker routes tracking events through) is always wired — it
// depends only on repositories/core dependencies. Its tracking notifications
// are appended to the notification outbox inside the business transaction
// (L8 PART 8/9) and relayed to the queue after commit.

import { ConfirmOrderEditUseCase } from "@api/use-cases/logistics/ConfirmOrderEditUseCase";
import { DispatchOrderFulfillmentUseCase } from "@api/use-cases/logistics/DispatchOrderFulfillmentUseCase";
import { FinalizeSwapTransactionUseCase } from "@api/use-cases/logistics/FinalizeSwapTransactionUseCase";
import { GenerateDraftOrderUseCase } from "@api/use-cases/logistics/GenerateDraftOrderUseCase";
import { GetOrderUseCase } from "@api/use-cases/logistics/GetOrderUseCase";
import { InitiateReturnAuthorizationUseCase } from "@api/use-cases/logistics/InitiateReturnAuthorizationUseCase";
import { ProcessCourierTrackingEventUseCase } from "@api/use-cases/logistics/ProcessCourierTrackingEventUseCase";
import { ProcessOrderSwapVarianceUseCase } from "@api/use-cases/logistics/ProcessOrderSwapVarianceUseCase";
import { ProposeOrderEditUseCase } from "@api/use-cases/logistics/ProposeOrderEditUseCase";
import { QueueLogisticsEventUseCase } from "@api/use-cases/logistics/QueueLogisticsEventUseCase";
import { VerifyLogisticsEventSignatureUseCase } from "@api/use-cases/logistics/VerifyLogisticsEventSignatureUseCase";
import { VerifySwapPaymentEventUseCase } from "@api/use-cases/logistics/VerifySwapPaymentEventUseCase";
import { ConfirmInventoryReservationUseCase } from "@api/use-cases/inventory/ConfirmInventoryReservationUseCase";
import { ReserveInventoryUseCase } from "@api/use-cases/inventory/ReserveInventoryUseCase";
import type { UseCaseDependencies, UseCaseReportBuilder } from "./types";

export interface LogisticsUseCases {
  confirmOrderEdit: ConfirmOrderEditUseCase;
  dispatchOrderFulfillment?: DispatchOrderFulfillmentUseCase;
  finalizeSwapTransaction: FinalizeSwapTransactionUseCase;
  generateDraftOrder: GenerateDraftOrderUseCase;
  getOrder: GetOrderUseCase;
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
  const getOrder = new GetOrderUseCase(
    deps.orderRepository,
    auditLogService,
    idGenerator,
    logger,
  );
  const proposeOrderEdit = new ProposeOrderEditUseCase(
    deps.orderRepository,
    deps.orderEditRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );

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
      deps.notificationOutboxRepository,
    );
  } else {
    report.unwiredUseCase(
      "DispatchOrderFulfillmentUseCase",
      "ILogisticsService",
      "L4/L5 invariant: worker logistics-event processing must never create shipments.",
    );
  }

  // --- Draft-order generation (L8 PART 3: outbox-migrated) -------------------
  // Always wired: the invoice intent is appended to the notification outbox
  // inside the same transaction as the draft order save, then relayed to the
  // queue AFTER commit by EnqueuePendingNotificationsUseCase. It no longer
  // depends on a live INotificationService.
  const generateDraftOrder = new GenerateDraftOrderUseCase(
    deps.draftOrderRepository,
    deps.notificationOutboxRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );

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
  const pricingService = deps.externalServices?.pricingService;

  // The swap flows hold and confirm replacement inventory through the SAME L9
  // reservation ledger the checkout flow uses (INV-I1..INV-I7), so the two
  // inventory orchestration use cases are composed here as well. Instances are
  // stateless, so the duplication with buildCheckoutUseCases is harmless.
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

  let processOrderSwapVariance: ProcessOrderSwapVarianceUseCase | undefined;
  if (paymentService && pricingService) {
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
      pricingService,
      deps.notificationOutboxRepository,
      reserveInventory,
    );
  } else {
    report.unwiredUseCase(
      "ProcessOrderSwapVarianceUseCase",
      paymentService ? "IPricingService" : "IPaymentService",
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
  // ITransactionManager. Tracking notifications are appended to the
  // notification outbox inside the same transaction (L8 PART 8/9) — order
  // lookup + outbox repository are therefore always injected.
  const processCourierTrackingEvent = new ProcessCourierTrackingEventUseCase(
    deps.fulfillmentRepository,
    transactionManager,
    auditLogService,
    idGenerator,
    logger,
    deps.orderRepository,
    deps.notificationOutboxRepository,
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
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
    confirmInventoryReservation,
  );

  report.wiredUseCases(
    "ConfirmOrderEditUseCase",
    "GetOrderUseCase",
    "ProposeOrderEditUseCase",
    "VerifySwapPaymentEventUseCase",
    "FinalizeSwapTransactionUseCase",
    "VerifyLogisticsEventSignatureUseCase",
    "QueueLogisticsEventUseCase",
    "ProcessCourierTrackingEventUseCase",
    "GenerateDraftOrderUseCase",
  );

  return {
    confirmOrderEdit,
    dispatchOrderFulfillment,
    finalizeSwapTransaction,
    generateDraftOrder,
    getOrder,
    initiateReturnAuthorization,
    processCourierTrackingEvent,
    processOrderSwapVariance,
    proposeOrderEdit,
    queueLogisticsEvent,
    verifyLogisticsEventSignature,
    verifySwapPaymentEvent,
  };
}
