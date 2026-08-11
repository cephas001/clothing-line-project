// apps/worker/src/workers/PaymentEventWorker.ts

// Concrete worker for the `payment-events-queue` published by
// QueuePaymentEventUseCase.
//
// Each job carries the gateway `parsedPayload`; its required fields match
// `WebhookPaymentFinalizeRequest`. The worker:
// - parses/validates the payload against the typed `PaymentEventJobPayload`
//   contract (malformed payloads fail permanently),
// - invokes `FinalizeOrderTransactionUseCase`, which enforces idempotency by
//   transaction reference and owns its transaction boundary via the injected
//   ITransactionManager (no transaction orchestration here),
// - lets all failures propagate so BullMQ applies the producer's configured
//   retry/backoff; exhausted attempts land in the queue's failed state, which
//   the existing dead-letter tooling (ProcessDeadLetterQueueUseCase,
//   ListDeadLetterJobsUseCase, retryJob) can inspect and replay.

import type { ConnectionOptions, WorkerOptions } from "bullmq";
import { QueueWorker } from "./QueueWorker";
import type { PaymentEventJobPayload } from "@api/domain/shared/jobs";
import { parsePaymentEventJobPayload, QUEUE_NAMES } from "@api/domain/shared/jobs";
import { FinalizeOrderTransactionUseCase } from "@api/use-cases/checkout/FinalizeOrderTransactionUseCase";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";

export interface PaymentEventWorkerOptions {
  /** BullMQ Redis connection config, derived from the shared REDIS_URL. */
  connection: ConnectionOptions;
  /** Consumer use case for a confirmed payment event. */
  finalizeOrderTransaction: FinalizeOrderTransactionUseCase;
  logger: ILogger;
  /** Must match the queue name used by QueuePaymentEventUseCase. */
  queueName?: string;
  workerOptions?: Partial<WorkerOptions>;
}

export class PaymentEventWorker {
  public static readonly DEFAULT_QUEUE_NAME = QUEUE_NAMES.paymentEvents;

  private readonly worker: QueueWorker<PaymentEventJobPayload>;

  constructor(options: PaymentEventWorkerOptions) {
    this.worker = new QueueWorker<PaymentEventJobPayload>({
      queueName:
        options.queueName ?? PaymentEventWorker.DEFAULT_QUEUE_NAME,
      connection: options.connection,
      logger: options.logger,
      workerOptions: options.workerOptions,
      handler: async (job) => {
        const payload = parsePaymentEventJobPayload(job.data);
        await options.finalizeOrderTransaction.execute(payload);
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
