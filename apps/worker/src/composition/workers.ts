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
// BulkCatalogImportWorker requires an injected processor because its consuming
// application use case (ProcessBulkCatalogImportUseCase) does not exist yet; it
// is left explicitly unavailable until the composition root is given one. No
// fake/no-op processor is ever substituted.
//
// Construction is side-effect-free (BullMQ v6 workers start only on run());
// WorkerRegistry.startAll()/closeAll() drive the lifecycle explicitly.

import type { ConnectionOptions } from "bullmq";
import type { FinalizeOrderTransactionUseCase } from "@api/use-cases/checkout/FinalizeOrderTransactionUseCase";
import type { VerifyPaymentEventUseCase } from "@api/use-cases/checkout/VerifyPaymentEventUseCase";
import type { FinalizeSwapTransactionUseCase } from "@api/use-cases/logistics/FinalizeSwapTransactionUseCase";
import type { VerifySwapPaymentEventUseCase } from "@api/use-cases/logistics/VerifySwapPaymentEventUseCase";
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
  /** Financial verification gate, provided by the checkout use-case factory. */
  verifyPaymentEvent: VerifyPaymentEventUseCase;
  /** Provided by the checkout use-case factory (always present once IAuditLogService is implemented). */
  finalizeOrderTransaction?: FinalizeOrderTransactionUseCase;
  /** Financial verification gate for swap obligations, provided by the logistics use-case factory. */
  verifySwapPaymentEvent?: VerifySwapPaymentEventUseCase;
  /** Atomic swap finalization, provided by the logistics use-case factory. */
  finalizeSwapTransaction?: FinalizeSwapTransactionUseCase;
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
