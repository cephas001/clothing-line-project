// apps/worker/src/workers/PaymentEventWorker.ts

// Concrete worker for the `payment-events-queue` published by
// QueuePaymentEventUseCase.
//
// Each job carries exactly the internal `PaymentEventJobPayload` contract
// (the provider-agnostic mapping of the `PaystackWebhookEvent` schema) — the
// raw Paystack webhook envelope never reaches this worker, so it is never
// parsed here. The payload is discriminated on `obligationType`:
//   - "checkout" -> VerifyPaymentEventUseCase then FinalizeOrderTransactionUseCase
//   - "swap"     -> VerifySwapPaymentEventUseCase then FinalizeSwapTransactionUseCase
// The worker:
// - re-validates the payload against the typed `PaymentEventJobPayload`
//   contract as defense-in-depth (a malformed payload is a PERMANENT failure:
//   QueueWorker classifies VALIDATION_ERROR as non-retryable),
// - runs the matching VERIFIER — the FINANCIAL VERIFICATION GATE. A valid
//   gateway signature is NOT sufficient: the event's reference, context,
//   identity, amount, currency, and obligation state are re-verified against
//   the DURABLE payment obligation in PostgreSQL (never the provider webhook as
//   the source of truth) BEFORE any finalization. Any mismatch throws a
//   terminal DomainError (INVALID_PAYMENT_AMOUNT / INVALID_CURRENCY /
//   PAYMENT_VERIFICATION_FAILED) and the job is never finalized,
// - invokes the matching FINALIZER ONLY AFTER verification passes, which
//   enforces idempotency by transaction reference (resolving a duplicate
//   reference to the existing order/swap) and owns its transaction boundary via
//   the injected ITransactionManager (no transaction orchestration here),
// - lets transient failures propagate so BullMQ applies the producer's
//   configured retry/backoff, while permanent/terminal failures are moved to
//   the failed state without retry (QueueWorker), where the existing dead-letter
//   tooling (ProcessDeadLetterQueueUseCase, ListDeadLetterJobsUseCase,
//   retryJob) can inspect and replay.

import type { ConnectionOptions, WorkerOptions } from "bullmq";
import { QueueWorker } from "./QueueWorker";
import type { PaymentEventJobPayload } from "@api/domain/shared/jobs";
import { parsePaymentEventJobPayload, QUEUE_NAMES } from "@api/domain/shared/jobs";
import { FinalizeOrderTransactionUseCase } from "@api/use-cases/checkout/FinalizeOrderTransactionUseCase";
import { VerifyPaymentEventUseCase } from "@api/use-cases/checkout/VerifyPaymentEventUseCase";
import { FinalizeSwapTransactionUseCase } from "@api/use-cases/logistics/FinalizeSwapTransactionUseCase";
import { VerifySwapPaymentEventUseCase } from "@api/use-cases/logistics/VerifySwapPaymentEventUseCase";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";

export interface PaymentEventWorkerOptions {
  /** BullMQ Redis connection config, derived from the shared REDIS_URL. */
  connection: ConnectionOptions;
  /**
   * Financial verification gate for checkout obligations: verifies the event
   * against the durable obligation before ANY finalization. Never skipped.
   */
  verifyPaymentEvent: VerifyPaymentEventUseCase;
  /** Consumer use case for a confirmed checkout payment event (runs only after verification). */
  finalizeOrderTransaction: FinalizeOrderTransactionUseCase;
  /**
   * Financial verification gate for swap obligations: verifies reference,
   * swap identity, exact amount/currency, and state before ANY finalization.
   */
  verifySwapPaymentEvent: VerifySwapPaymentEventUseCase;
  /** Consumer use case for a confirmed swap payment event (runs only after verification). */
  finalizeSwapTransaction: FinalizeSwapTransactionUseCase;
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
        // Financial verification FIRST: webhook -> signature (HTTP) -> resolve
        // obligation -> verify reference -> verify amount -> verify currency ->
        // verify state -> ONLY THEN finalize. A valid signature is not sufficient.
        if (payload.obligationType === "swap") {
          await options.verifySwapPaymentEvent.execute(payload);
          await options.finalizeSwapTransaction.execute(payload);
          return;
        }
        await options.verifyPaymentEvent.execute(payload);
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
