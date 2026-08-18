// apps/worker/src/bootstrap.ts

// Worker runtime composition root — the OUTER runtime of the application.
//
// Unlike apps/api, this runtime has no HTTP surface. It composes the SAME
// shared domain/application/infrastructure code (imported from
// @clothing-line-project/api via @api/* aliases) and owns only:
//   1. configuration (reused apps/api composition/config.ts),
//   2. construction of every concrete infrastructure service + repository
//      (reused apps/api composition factories),
//   3. wiring of use cases (reused apps/api factories),
//   4. wiring of workers (moved into this package),
//   5. explicit start (workers begin consuming ONLY on start(), never on import),
//   6. graceful shutdown in dependency order (workers -> queue -> db -> redis).
//
// Unwired capabilities are REPORTED, never faked:
//   - IAuditLogService is implemented by PostgresAuditLogService (constructed
//     in buildInfrastructure) and injected into every use case that needs it.
//     An optional `auditLogService` override may be supplied to
//     bootstrapWorker({ auditLogService }) and replaces the default.
//   - BulkCatalogImportWorker stays unavailable until a processor is supplied.

import type { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import type { BulkCatalogImportProcessor } from "./workers/BulkCatalogImportWorker";
import { loadAppConfig } from "@api/infrastructure/composition/config";
import {
  buildInfrastructure,
  disposeInfrastructure,
  InfrastructureDependencies,
} from "@api/infrastructure/composition/infrastructure";
import { buildNotificationService } from "@api/infrastructure/composition/notificationService";
import { buildRepositories, Repositories } from "@api/infrastructure/composition/repositories";
import { buildUseCases, UseCaseComposition } from "@api/infrastructure/composition/useCases";
import { useCaseReportLines } from "@api/infrastructure/composition/useCases/types";
import { buildWorkers, WorkerComposition } from "./composition/workers";

export interface WorkerBootstrapOptions {
  /**
   * Optional IAuditLogService override. Defaults to the concrete
   * PostgresAuditLogService constructed by buildInfrastructure; supply a
   * different implementation only to replace the default (e.g. in tests).
   */
  auditLogService?: IAuditLogService;
  /** Processor for BulkCatalogImportWorker; supplied once its use case exists. */
  bulkCatalogImportProcessor?: BulkCatalogImportProcessor;
}

export interface WorkerRuntime {
  config: ReturnType<typeof loadAppConfig>;
  infrastructure: InfrastructureDependencies;
  repositories: Repositories;
  useCases: UseCaseComposition;
  workers: WorkerComposition;
  /**
   * Explicitly start consuming workers. Never invoked by importing this
   * module — the caller (worker index) decides when the process is ready.
   */
  start(): Promise<void>;
  /**
   * Graceful shutdown: stop accepting new worker jobs, then close the queue
   * connections, the Postgres pool, and the session-revocation Redis client.
   * Idempotent.
   */
  shutdown(): Promise<void>;
  /** Human-readable startup/wiring summary for the bootstrap log. */
  describe(): string;
}

export function bootstrapWorker(
  options: WorkerBootstrapOptions = {},
): WorkerRuntime {
  const config = loadAppConfig();
  const infrastructure = buildInfrastructure(config, { component: "worker" });
  const repositories = buildRepositories(infrastructure.transactionContext);
  const logger = infrastructure.logger;

  // --- Product read cache: deliberately OUT of scope here (L9-T) --------------
  // The API composition root (bootstrapApplication) wraps productReadRepository
  // with CachedProductReadRepository and the product/variant/moneyAmount write
  // repos with the Invalidating* decorators. This worker runtime builds the
  // SAME factories directly, so it constructs ONLY the plain Postgres
  // repositories: no product cache decorator, no product cache keyspace, no
  // PRODUCT_CACHE_TTL_SECONDS requirement. Workers that never perform product
  // reads (payment/logistics/notification event handling) therefore never
  // require Redis for product reads — Redis here exists solely for BullMQ
  // (queueService/bullConnection) and session revocation. If a future worker
  // needs product reads, wire the decorator HERE, never inside a use case.

  // --- Use cases: every use case receives the concrete IAuditLogService -------
  // The worker runtime deliberately wires NO external services into use cases:
  // its workers consume only the always-wired use cases (payment verification +
  // finalization, swap finalization, courier tracking) plus the notification
  // outbox. Use cases that depend on an external service are classified as
  // deferred by design, never as configuration gaps.
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
    },
    { runtime: "worker" },
  );
  logger.info("Use cases composed", {
    runtime: "worker",
    wired: useCases.report.summary.wired,
    unavailableMissingInfrastructure:
      useCases.report.summary.unavailableMissingInfrastructure,
    unavailableMissingConfiguration:
      useCases.report.summary.unavailableMissingConfiguration,
    deferredByDesign: useCases.report.summary.deferredByDesign,
  });

  // --- Notification service (Resend) via the shared composition factory ------
  // Constructed in infrastructure/composition only; undefined when
  // NOTIFICATION_API_KEY is absent (the NotificationEventWorker is then
  // reported unavailable, never faked).
  const notificationService = buildNotificationService(config, logger);

  // --- Workers: PaymentEventWorker verifies THEN finalizes -------------------
  // Financial verification (VerifyPaymentEventUseCase) runs before
  // FinalizeOrderTransactionUseCase for every checkout event, and
  // VerifySwapPaymentEventUseCase before FinalizeSwapTransactionUseCase for
  // every swap event (dispatched on the payload's obligationType).
  //
  // LogisticsEventWorker routes every provider-neutral logistics event through
  // ProcessCourierTrackingEventUseCase (resolve by providerShipmentId -> apply
  // the state machines -> persist via ITransactionManager -> audit). The worker
  // never creates shipments, never calls Shipbubble, and never holds a
  // transaction across anything external.
  //
  // NotificationEventWorker completes the durable notification pipeline
  // (L8-R): resolve the outbox row by id -> dispatch OUTSIDE any transaction
  // (recipient-preference suppression happens inside the adapter BEFORE the
  // provider call) -> persist the dispatch receipt in a short transaction.
  const workers = buildWorkers({
    logger,
    bullConnection: infrastructure.bullConnection,
    verifyPaymentEvent: useCases.useCases.checkout.verifyPaymentEvent,
    finalizeOrderTransaction: useCases.useCases.checkout.finalizeOrderTransaction,
    verifySwapPaymentEvent: useCases.useCases.logistics.verifySwapPaymentEvent,
    finalizeSwapTransaction: useCases.useCases.logistics.finalizeSwapTransaction,
    processCourierTrackingEvent:
      useCases.useCases.logistics.processCourierTrackingEvent,
    bulkCatalogImportProcessor: options.bulkCatalogImportProcessor,
    notificationOutboxRepository: repositories.notificationOutboxRepository,
    transactionManager: infrastructure.transactionManager,
    notificationService,
  });

  let shutDown = false;

  const runtime: WorkerRuntime = {
    config,
    infrastructure,
    repositories,
    useCases,
    workers,

    async start(): Promise<void> {
      await workers.registry.startAll();
      if (workers.report.started.length > 0) {
        logger.info("Workers started", {
          workers: workers.report.started,
        });
      }
    },

    async shutdown(): Promise<void> {
      if (shutDown) {
        return;
      }
      shutDown = true;
      await workers.registry.closeAll();
      await disposeInfrastructure(infrastructure);
      logger.info("Worker runtime shut down cleanly");
    },

    describe(): string {
      const lines: string[] = [];
      lines.push(`Redis: ${config.redisUrl}`);
      lines.push("");
      lines.push(...useCaseReportLines(useCases.report));
      lines.push("");
      lines.push(
        `Workers: ${workers.report.started.join(", ") || "none started"}`,
      );
      for (const w of workers.report.unavailable) {
        const label =
          w.status === "unavailable-missing-infrastructure"
            ? "Unavailable — missing infrastructure capability"
            : "Unavailable — missing configuration";
        lines.push(`  ${label}: ${w.worker} (${w.missingDependency})`);
      }
      return lines.map((line) => (line === "" ? line : `  ${line}`)).join("\n");
    },
  };

  return runtime;
}
