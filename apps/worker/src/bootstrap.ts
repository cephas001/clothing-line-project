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
import { buildRepositories, Repositories } from "@api/infrastructure/composition/repositories";
import { buildUseCases, UseCaseComposition } from "@api/infrastructure/composition/useCases";
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
  const infrastructure = buildInfrastructure(config);
  const repositories = buildRepositories(infrastructure.transactionContext);
  const logger = infrastructure.logger;

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
  });
  logger.info("Use cases composed", {
    wired: useCases.report.wired.length,
    unwired: useCases.report.unwired.length,
  });

  // --- Workers: PaymentEventWorker consumes the composed FinalizeOrderTransactionUseCase ---
  const workers = buildWorkers({
    logger,
    bullConnection: infrastructure.bullConnection,
    finalizeOrderTransaction: useCases.useCases.checkout.finalizeOrderTransaction,
    bulkCatalogImportProcessor: options.bulkCatalogImportProcessor,
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
      lines.push(
        `Use cases: ${useCases.report.wired.length} wired, ` +
          `${useCases.report.unwired.length} unwired`,
      );
      for (const u of useCases.report.unwired) {
        lines.push(`  unwired: ${u.useCase} (missing ${u.missingDependency})`);
      }
      lines.push(
        `Workers: ${workers.report.started.join(", ") || "none started"}`,
      );
      for (const w of workers.report.unavailable) {
        lines.push(`  unavailable: ${w.worker} (${w.missingDependency})`);
      }
      return lines.join("\n");
    },
  };

  return runtime;
}
