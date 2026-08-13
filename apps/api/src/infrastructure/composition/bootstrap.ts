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
    externalServices: options.externalServices,
  });
  logger.info("Use cases composed", {
    wired: useCases.report.wired.length,
    unwired: useCases.report.unwired.length,
  });

  let shutDown = false;

  const runtime: ApplicationRuntime = {
    config,
    infrastructure,
    repositories,
    useCases,

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
      return lines.join("\n");
    },
  };

  return runtime;
}
