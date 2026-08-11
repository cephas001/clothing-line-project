// apps/worker/src/composition/workers.ts

// Wires the background workers through the composition root.
//
// PaymentEventWorker receives the FinalizeOrderTransactionUseCase instance
// constructed by the checkout use-case factory (dependency injection — its
// business logic is never recreated here). It is only built when that use case
// exists, which in turn requires IAuditLogService.
//
// BulkCatalogImportWorker requires an injected processor because its consuming
// application use case (ProcessBulkCatalogImportUseCase) does not exist yet; it
// is left explicitly unavailable until the composition root is given one. No
// fake/no-op processor is ever substituted.
//
// Construction is side-effect-free (BullMQ v6 workers start only on run());
// WorkerRegistry.startAll()/closeAll() drive the lifecycle explicitly.

import type { ConnectionOptions } from "bullmq";
import type { FinalizeOrderTransactionUseCase } from "@api/use-cases/checkout/FinalizeOrderTransactionUseCase";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { WorkerRegistry } from "../workers/WorkerRegistry";
import { PaymentEventWorker } from "../workers/PaymentEventWorker";
import {
  BulkCatalogImportWorker,
  BulkCatalogImportProcessor,
} from "../workers/BulkCatalogImportWorker";

export interface WorkerBuildOptions {
  logger: ILogger;
  /** BullMQ connection config derived from REDIS_URL by the composition root. */
  bullConnection: ConnectionOptions;
  /** Provided by the checkout use-case factory; present only when IAuditLogService exists. */
  finalizeOrderTransaction?: FinalizeOrderTransactionUseCase;
  /** Provided once ProcessBulkCatalogImportUseCase (or an equivalent processor) exists. */
  bulkCatalogImportProcessor?: BulkCatalogImportProcessor;
}

export interface WorkerComposition {
  registry: WorkerRegistry;
  report: {
    started: string[];
    unavailable: Array<{ worker: string; missingDependency: string }>;
  };
}

export function buildWorkers(options: WorkerBuildOptions): WorkerComposition {
  const registry = new WorkerRegistry();
  const started: string[] = [];
  const unavailable: WorkerComposition["report"]["unavailable"] = [];

  if (options.finalizeOrderTransaction) {
    registry.register(
      new PaymentEventWorker({
        connection: options.bullConnection,
        finalizeOrderTransaction: options.finalizeOrderTransaction,
        logger: options.logger,
      }),
    );
    started.push("PaymentEventWorker");
  } else {
    unavailable.push({
      worker: "PaymentEventWorker",
      missingDependency:
        "FinalizeOrderTransactionUseCase (blocked on IAuditLogService)",
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
    });
  }

  return { registry, report: { started, unavailable } };
}
