// apps/worker/src/composition/workers.ts

// Wires the background workers through the composition root.
//
// PaymentEventWorker receives the VerifyPaymentEventUseCase AND the
// FinalizeOrderTransactionUseCase instances constructed by the checkout
// use-case factory, plus the VerifySwapPaymentEventUseCase and
// FinalizeSwapTransactionUseCase instances from the logistics factory
// (dependency injection - their business logic is never recreated here).
// Verification ALWAYS runs before finalization for BOTH obligation types
// ("checkout" and "swap"); the worker dispatches on the payload's
// `obligationType`. All four are always present because they only depend on
// repositories/IAuditLogService.
//
// LogisticsEventWorker consumes the logistics-events-queue (L5): it routes
// every provider-neutral logistics event through
// ProcessCourierTrackingEventUseCase (resolve by providerShipmentId -> apply
// the state machines -> persist via ITransactionManager -> audit). The worker
// itself never creates shipments, never calls Shipbubble, and never holds a
// transaction across anything external.
//
// BulkCatalogImportWorker requires an injected processor because its consuming
// application use case (ProcessBulkCatalogImportUseCase) does not exist yet; it
// is left explicitly unavailable until the composition root is given one. No
// fake/no-op processor is ever substituted.
//
// NotificationEventWorker consumes the notification-events-queue (L8-R): it
// re-validates the typed job payload, resolves the authoritative outbox row by
// id, calls INotificationService OUTSIDE any DB transaction (suppression is
// enforced inside the adapter BEFORE the provider call), and persists the
// dispatch receipt via ITransactionManager in a SHORT local transaction. It is
// registered whenever an INotificationService is present (i.e.
// NOTIFICATION_API_KEY is set) — the outbox repository, transaction manager,
// and logger are always injected; a missing notification service is REPORTED
// unavailable, never faked.
//
// Construction is side-effect-free (QueueWorker pins BullMQ v6.0.10's autorun
// option to false, so workers start only on run()); WorkerRegistry.startAll()/
// closeAll() drive the lifecycle explicitly.

import type { ConnectionOptions } from "bullmq";
import type { FinalizeOrderTransactionUseCase } from "@api/use-cases/checkout/FinalizeOrderTransactionUseCase";
import type { VerifyPaymentEventUseCase } from "@api/use-cases/checkout/VerifyPaymentEventUseCase";
import type { FinalizeSwapTransactionUseCase } from "@api/use-cases/logistics/FinalizeSwapTransactionUseCase";
import type { VerifySwapPaymentEventUseCase } from "@api/use-cases/logistics/VerifySwapPaymentEventUseCase";
import type { ProcessCourierTrackingEventUseCase } from "@api/use-cases/logistics/ProcessCourierTrackingEventUseCase";
import type { INotificationService } from "@api/domain/shared/notifications";
import type { INotificationOutboxRepository } from "@api/domain/interfaces/repositories/INotificationOutboxRepository";
import type { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { WorkerRegistry } from "../workers/WorkerRegistry";
import { PaymentEventWorker } from "../workers/PaymentEventWorker";
import { LogisticsEventWorker } from "../workers/LogisticsEventWorker";
import { NotificationEventWorker } from "../workers/NotificationEventWorker";
import {
  BulkCatalogImportWorker,
  BulkCatalogImportProcessor,
} from "../workers/BulkCatalogImportWorker";

export interface WorkerBuildOptions {
  logger: ILogger;
  /** BullMQ connection config derived from REDIS_URL by the composition root. */
  bullConnection: ConnectionOptions;
  /** Financial verification gate, provided by the checkout use-case factory. */
  verifyPaymentEvent: VerifyPaymentEventUseCase;
  /** Provided by the checkout use-case factory (always present once IAuditLogService is implemented). */
  finalizeOrderTransaction?: FinalizeOrderTransactionUseCase;
  /** Financial verification gate for swap obligations, provided by the logistics use-case factory. */
  verifySwapPaymentEvent?: VerifySwapPaymentEventUseCase;
  /** Atomic swap finalization, provided by the logistics use-case factory. */
  finalizeSwapTransaction?: FinalizeSwapTransactionUseCase;
  /** Logistics-event consumer, provided by the logistics use-case factory (always present). */
  processCourierTrackingEvent: ProcessCourierTrackingEventUseCase;
  /** Provided once ProcessBulkCatalogImportUseCase (or an equivalent processor) exists. */
  bulkCatalogImportProcessor?: BulkCatalogImportProcessor;
  /** Durable notification outbox the worker reconciles (always present). */
  notificationOutboxRepository: INotificationOutboxRepository;
  /** Opens the SHORT transaction that persists the dispatch receipt. */
  transactionManager: ITransactionManager;
  /**
   * Provider-neutral notification service. Present only when the composition
   * root could construct the Resend adapter (NOTIFICATION_API_KEY set);
   * otherwise the worker is reported unavailable.
   */
  notificationService?: INotificationService;
}

export interface WorkerComposition {
  registry: WorkerRegistry;
  report: {
    started: string[];
    unavailable: Array<{
      worker: string;
      missingDependency: string;
      /** Availability classification for the startup diagnostics. */
      status:
        | "unavailable-missing-infrastructure"
        | "unavailable-missing-configuration";
    }>;
  };
}

export function buildWorkers(options: WorkerBuildOptions): WorkerComposition {
  const registry = new WorkerRegistry();
  const started: string[] = [];
  const unavailable: WorkerComposition["report"]["unavailable"] = [];

  if (
    options.finalizeOrderTransaction &&
    options.verifySwapPaymentEvent &&
    options.finalizeSwapTransaction
  ) {
    registry.register(
      new PaymentEventWorker({
        connection: options.bullConnection,
        verifyPaymentEvent: options.verifyPaymentEvent,
        finalizeOrderTransaction: options.finalizeOrderTransaction,
        verifySwapPaymentEvent: options.verifySwapPaymentEvent,
        finalizeSwapTransaction: options.finalizeSwapTransaction,
        logger: options.logger,
      }),
    );
    started.push("PaymentEventWorker");
  } else {
    unavailable.push({
      worker: "PaymentEventWorker",
      missingDependency:
        "FinalizeOrderTransactionUseCase (blocked on IAuditLogService)",
      status: "unavailable-missing-infrastructure",
    });
  }

  if (options.bulkCatalogImportProcessor) {
    registry.register(
      new BulkCatalogImportWorker({
        connection: options.bullConnection,
        processor: options.bulkCatalogImportProcessor,
        logger: options.logger,
      }),
    );
    started.push("BulkCatalogImportWorker");
  } else {
    unavailable.push({
      worker: "BulkCatalogImportWorker",
      missingDependency: "ProcessBulkCatalogImportUseCase (injected processor)",
      status: "unavailable-missing-infrastructure",
    });
  }

  // LogisticsEventWorker consumes the logistics-events-queue. The consumer use
  // case (ProcessCourierTrackingEventUseCase) is always wired by the logistics
  // use-case factory, so the worker is always registered.
  registry.register(
    new LogisticsEventWorker({
      connection: options.bullConnection,
      processCourierTrackingEvent: options.processCourierTrackingEvent,
      logger: options.logger,
    }),
  );
  started.push("LogisticsEventWorker");

  // NotificationEventWorker consumes the notification-events-queue. The outbox
  // repository + transaction manager are always present; the worker is
  // registered only when an INotificationService (the Resend adapter) was
  // constructed. It completes the durable pipeline: resolve the row by id ->
  // dispatch OUTSIDE any transaction (suppression happens inside the adapter
  // BEFORE the provider call) -> persist the receipt in a short transaction.
  if (options.notificationService) {
    registry.register(
      new NotificationEventWorker({
        connection: options.bullConnection,
        outboxRepository: options.notificationOutboxRepository,
        notificationService: options.notificationService,
        transactionManager: options.transactionManager,
        logger: options.logger,
      }),
    );
    started.push("NotificationEventWorker");
  } else {
    unavailable.push({
      worker: "NotificationEventWorker",
      missingDependency: "INotificationService (NOTIFICATION_API_KEY not set)",
      status: "unavailable-missing-configuration",
    });
  }

  return { registry, report: { started, unavailable } };
}
