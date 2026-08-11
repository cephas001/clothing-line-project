// apps/api/src/infrastructure/composition/useCases/logistics.ts

// Factory for the logistics use cases. Each use case is constructed ONLY when
// all of its dependencies are present; missing dependencies are reported
// rather than faked.
//
// NOTE: ProcessCourierTrackingEventUseCase (whose file is named
// `ProcessCourierTrackingEventUseCase.ts.ts`) requires INotificationService and
// is therefore unwired today; it is reported without importing its malformed
// filename.

import { ConfirmOrderEditUseCase } from "@api/use-cases/logistics/ConfirmOrderEditUseCase";
import { DetermineSourcingLocationUseCase } from "@api/use-cases/logistics/DetermineSourcingLocationUseCase";
import { DispatchOrderFulfillmentUseCase } from "@api/use-cases/logistics/DispatchOrderFulfillmentUseCase";
import { GenerateDraftOrderUseCase } from "@api/use-cases/logistics/GenerateDraftOrderUseCase";
import { InitiateReturnAuthorizationUseCase } from "@api/use-cases/logistics/InitiateReturnAuthorizationUseCase";
import { ProcessOrderSwapVarianceUseCase } from "@api/use-cases/logistics/ProcessOrderSwapVarianceUseCase";
import { ProposeOrderEditUseCase } from "@api/use-cases/logistics/ProposeOrderEditUseCase";
import type { UseCaseDependencies, UseCaseReportBuilder } from "./types";

export interface LogisticsUseCases {
  confirmOrderEdit: ConfirmOrderEditUseCase;
  determineSourcingLocation?: DetermineSourcingLocationUseCase;
  dispatchOrderFulfillment?: DispatchOrderFulfillmentUseCase;
  generateDraftOrder?: GenerateDraftOrderUseCase;
  initiateReturnAuthorization?: InitiateReturnAuthorizationUseCase;
  processOrderSwapVariance?: ProcessOrderSwapVarianceUseCase;
  proposeOrderEdit: ProposeOrderEditUseCase;
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
      deps.swapRepository,
      paymentService,
      auditLogService,
      idGenerator,
      logger,
      transactionManager,
    );
  } else {
    report.unwiredUseCase(
      "ProcessOrderSwapVarianceUseCase",
      "IPaymentService",
    );
  }

  report.unwiredUseCase(
    "ProcessCourierTrackingEventUseCase",
    "INotificationService",
  );

  report.wiredUseCases(
    "ConfirmOrderEditUseCase",
    "ProposeOrderEditUseCase",
  );

  return {
    confirmOrderEdit,
    determineSourcingLocation,
    dispatchOrderFulfillment,
    generateDraftOrder,
    initiateReturnAuthorization,
    processOrderSwapVariance,
    proposeOrderEdit,
  };
}
