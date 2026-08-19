// apps/worker/src/workers/BulkCatalogImportWorker.ts

// Concrete worker for the `bulk-import-queue` published by
// ImportBulkCatalogDataUseCase.
//
// The consumer use case (ProcessBulkCatalogImportUseCase) does not exist yet,
// so this worker requires an injected processor that receives the typed
// `BulkCatalogImportJobPayload`. The composition root supplies the processor
// and wires it to the use case once it lands; until then the worker is
// registered with a no-op-free, non-processing processor only if the operator
// explicitly decides to start it. This keeps the worker complete and honest
// about the gap without inventing speculative domain behavior.
//
// Like every worker here it parses the payload against the typed contract
// first and lets failures propagate so BullMQ applies the producer's
// retry/backoff.

import type { ConnectionOptions, WorkerOptions } from "bullmq";
import { QueueWorker } from "./QueueWorker";
import type { BulkCatalogImportJobPayload } from "@api/domain/shared/jobs";
import { parseBulkCatalogImportJobPayload, QUEUE_NAMES } from "@api/domain/shared/jobs";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";

export type BulkCatalogImportProcessor = (
  payload: BulkCatalogImportJobPayload,
) => Promise<void>;

export interface BulkCatalogImportWorkerOptions {
  /** BullMQ Redis connection config, derived from the shared REDIS_URL. */
  connection: ConnectionOptions;
  /**
   * Applies a parsed bulk-import payload. Wire this to the future
   * ProcessBulkCatalogImportUseCase (downloads the file at `fileUrl`, parses
   * CSV/JSON, and applies catalog changes via the catalog use cases).
   */
  processor: BulkCatalogImportProcessor;
  logger: ILogger;
  /** Must match the queue name used by ImportBulkCatalogDataUseCase. */
  queueName?: string;
  workerOptions?: Partial<WorkerOptions>;
}

export class BulkCatalogImportWorker {
  public static readonly DEFAULT_QUEUE_NAME = QUEUE_NAMES.bulkCatalogImport;

  private readonly worker: QueueWorker<BulkCatalogImportJobPayload>;

  constructor(options: BulkCatalogImportWorkerOptions) {
    this.worker = new QueueWorker<BulkCatalogImportJobPayload>({
      queueName:
        options.queueName ?? BulkCatalogImportWorker.DEFAULT_QUEUE_NAME,
      connection: options.connection,
      logger: options.logger,
      workerOptions: options.workerOptions,
      handler: async (job) => {
        const payload = parseBulkCatalogImportJobPayload(job.data);
        await options.processor(payload);
      },
    });
  }

  start(): Promise<void> {
    return this.worker.start();
  }

  close(): Promise<void> {
    return this.worker.close();
  }
}
