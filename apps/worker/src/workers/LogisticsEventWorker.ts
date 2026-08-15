// apps/worker/src/workers/LogisticsEventWorker.ts

// Concrete worker for the `logistics-events-queue` published by
// QueueLogisticsEventUseCase.
//
// Each job carries exactly the internal `LogisticsEventJobPayload` contract
// (the provider-neutral projection of a `ProviderLogisticsEvent` produced by
// the Shipbubble webhook mapper) — the raw Shipbubble webhook envelope never
// reaches this worker, so it is never parsed here. The worker:
// - re-validates the payload against the typed `LogisticsEventJobPayload`
//   contract as defense-in-depth (a malformed payload is a PERMANENT failure:
//   QueueWorker classifies VALIDATION_ERROR as non-retryable),
// - routes the job through ProcessCourierTrackingEventUseCase, which resolves
//   the local fulfillment by providerShipmentId (NEVER orderId/trackingNumber/
//   cartId), maps provider events onto the domain state machines (courier
//   tracking progress + ambiguous-dispatch advance), rejects impossible
//   backwards transitions, drops stale events idempotently, persists via the
//   injected ITransactionManager, and audits AFTER commit,
// - NEVER creates shipments, NEVER calls Shipbubble APIs, and NEVER opens a
//   transaction around anything external,
// - lets transient failures propagate so BullMQ applies the producer's
//   configured retry/backoff (e.g. a missing local fulfillment is classified
//   LOGISTICS_EVENT_FULFILLMENT_NOT_FOUND -> retryable, bounded by the
//   producer's attempts), while permanent/terminal failures are moved to the
//   failed state without retry (QueueWorker), where the existing dead-letter
//   tooling can inspect and replay.

import type { ConnectionOptions, WorkerOptions } from "bullmq";
import { QueueWorker } from "./QueueWorker";
import {
  parseLogisticsEventJobPayload,
  QUEUE_NAMES,
} from "@api/domain/shared/jobs";
import type { LogisticsEventJobPayload } from "@api/domain/shared/jobs";
import type { ProcessCourierTrackingEventUseCase } from "@api/use-cases/logistics/ProcessCourierTrackingEventUseCase";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";

export interface LogisticsEventWorkerOptions {
  /** BullMQ Redis connection config, derived from the shared REDIS_URL. */
  connection: ConnectionOptions;
  /**
   * Consumer use case that reconciles a provider-neutral logistics event
   * against durable fulfillment state (resolve by providerShipmentId -> apply
   * the state machines -> persist via ITransactionManager -> audit).
   */
  processCourierTrackingEvent: ProcessCourierTrackingEventUseCase;
  logger: ILogger;
  /** Must match the queue name used by QueueLogisticsEventUseCase. */
  queueName?: string;
  workerOptions?: Partial<WorkerOptions>;
}

export class LogisticsEventWorker {
  public static readonly DEFAULT_QUEUE_NAME = QUEUE_NAMES.logisticsEvents;

  private readonly worker: QueueWorker<LogisticsEventJobPayload>;

  constructor(options: LogisticsEventWorkerOptions) {
    this.worker = new QueueWorker<LogisticsEventJobPayload>({
      queueName: options.queueName ?? LogisticsEventWorker.DEFAULT_QUEUE_NAME,
      connection: options.connection,
      logger: options.logger,
      workerOptions: options.workerOptions,
      handler: async (job) => {
        // Re-validate against the typed internal contract as defense-in-depth;
        // a malformed payload is a permanent failure (VALIDATION_ERROR).
        const payload = parseLogisticsEventJobPayload(job.data);
        // Route through the application use case: resolve by providerShipmentId,
        // apply the state machines, persist via ITransactionManager, audit after
        // commit. Never creates shipments, never calls Shipbubble.
        await options.processCourierTrackingEvent.execute({
          logisticsEvent: payload,
        });
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