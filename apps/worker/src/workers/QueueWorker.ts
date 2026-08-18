// apps/worker/src/workers/QueueWorker.ts

// Reusable BullMQ worker harness for the application's background queues.
//
// Responsibilities:
// - Wrap a BullMQ Worker so consumers receive a typed payload contract
//   (`WorkerJob<TPayload>`) instead of raw BullMQ Job access.
// - Constructing a worker is side-effect-free: BullMQ v6.0.10 defaults
//   `autorun: true` (the Worker starts consuming in its constructor), so this
//   harness pins `autorun: false` and begins processing only when `start()` ->
//   `run()` is called. The composition root can therefore build every worker
//   at bootstrap and start them together via start()/WorkerRegistry.
// - Log structured context (queue, jobId, attemptsMade) around every job and
//   CLASSIFY failures before deciding retry semantics:
//
//     kind      | condition                              | behavior
//     permanent | DomainError VALIDATION_ERROR /          | moved to failed with
//               | INVALID_INPUT (malformed payload/input)| NO transient retry
//     terminal  | domain conflict / already-completed /  | moved to failed with
//               | data anomaly (DUPLICATE_TRANSACTION,   | NO transient retry
//               | INVALID_PAYMENT_AMOUNT, INVALID_*...)  |
//     retry     | transient CONNECTION/TIMEOUT, provider | BullMQ applies the
//               | /infrastructure errors, unexpected     | producer's configured
//               | errors                                 | attempts + backoff
//
//   Permanent and terminal failures throw `PermanentJobFailure`, whose
//   `name` is "UnrecoverableError" — BullMQ's `shouldRetryJob` then moves the
//   job to failed even when attempts remain, so a poison payload or an
//   already-resolved operation is never retried into an infinite backoff loop.
//   All other failures are rethrown untouched so BullMQ applies the producer's
//   configured retry/backoff; exhausted attempts land in the queue's failed
//   state for the existing dead-letter tooling to inspect and replay.
// - Idempotent resolution of already-completed operations is owned by the use
//   cases (e.g. FinalizeOrderTransactionUseCase returns the existing order for
//   a duplicate reference); if a domain-conflict error still reaches the
//   worker it is classified terminal and never retried.
// - Never opens transactions: use cases invoked by handlers own the
//   ITransactionManager boundary.

import { Worker } from "bullmq";
import type { ConnectionOptions, Job, WorkerOptions } from "bullmq";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { RepositoryErrorCode } from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Failure raised for errors that must NOT be transiently retried: malformed
 * payloads (permanent) and domain conflicts / already-completed / data
 * anomalies (terminal). `name` is set to "UnrecoverableError" because BullMQ's
 * `shouldRetryJob` skips retries for errors with that name, moving the job
 * straight to the failed state (where the dead-letter tooling can inspect it).
 */
export class PermanentJobFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "UnrecoverableError";
    this.code = code;
  }
}

export type JobFailureKind = "permanent" | "terminal" | "retry";

/** Minimal infra-owned view of a job; keeps BullMQ types out of handlers. */
export interface WorkerJob<TPayload> {
  id: string;
  name: string;
  attemptsMade: number;
  data: TPayload;
}

export type QueueJobHandler<TPayload> = (
  job: WorkerJob<TPayload>,
) => Promise<void>;

export interface QueueWorkerOptions<TPayload> {
  queueName: string;
  /** BullMQ Redis connection config (host/port/url/password/...). */
  connection: ConnectionOptions;
  handler: QueueJobHandler<TPayload>;
  logger: ILogger;
  workerOptions?: Partial<WorkerOptions>;
}

export class QueueWorker<TPayload> {
  private readonly worker: Worker<TPayload, void, string>;
  private readonly logger: ILogger;
  private readonly queueName: string;

  constructor(options: QueueWorkerOptions<TPayload>) {
    this.queueName = options.queueName;
    this.logger = options.logger;

    this.worker = new Worker<TPayload, void, string>(
      options.queueName,
      (bullJob) => this.process(bullJob, options.handler),
      {
        ...(options.workerOptions ?? {}),
        connection: options.connection,
        // BullMQ v6.0.10 defaults autorun to true, which would start consuming
        // inside the constructor and make the later explicit start() -> run()
        // throw "Worker is already running". Pin it off so construction stays
        // side-effect-free and the WorkerRegistry lifecycle drives consuming.
        autorun: false,
      },
    );

    // Connection-level errors (e.g. Redis down) surface on the worker's 'error'
    // event; log them for observability. They do not kill the worker.
    this.worker.on("error", (err) => {
      this.logger.error("Queue worker reported an error", {
        queue: this.queueName,
        err,
      });
    });
  }

  /** Begin consuming from the queue. No-op-safe: BullMQ ignores re-runs. */
  async start(): Promise<void> {
    this.logger.info("Starting queue worker", { queue: this.queueName });
    // BullMQ v6 `run()` returns a promise that resolves only when the worker's
    // main loop EXITS (i.e. on close). It must NOT be awaited here: that would
    // block WorkerRegistry.startAll() forever on the first worker and every
    // later worker would never start consuming. Fire-and-forget the run
    // promise (its rejection is surfaced via the 'error' event and logged) and
    // gate on waitUntilReady(), which resolves once both Redis connections
    // (main + blocking) are ready.
    void this.worker
      .run()
      .catch((err: unknown) => {
        this.logger.error("Queue worker failed to run", {
          queue: this.queueName,
          err,
        });
      });
    await this.worker.waitUntilReady();
    this.logger.info("Queue worker started", { queue: this.queueName });
  }

  async waitUntilReady(): Promise<void> {
    await this.worker.waitUntilReady();
  }

  /** Stop consuming and release the underlying Redis connection. */
  async close(): Promise<void> {
    this.logger.info("Closing queue worker", { queue: this.queueName });
    await this.worker.close();
  }

  private async process(
    bullJob: Job<TPayload, void, string>,
    handler: QueueJobHandler<TPayload>,
  ): Promise<void> {
    const job: WorkerJob<TPayload> = {
      id: bullJob.id ?? "",
      name: bullJob.name,
      attemptsMade: bullJob.attemptsMade,
      data: bullJob.data,
    };

    this.logger.info("Worker processing job", {
      queue: this.queueName,
      jobId: job.id,
      attemptsMade: job.attemptsMade,
    });

    try {
      await handler(job);
      this.logger.info("Worker completed job", {
        queue: this.queueName,
        jobId: job.id,
      });
    } catch (err) {
      const kind = classifyError(err);
      this.logFailure(err, kind, job);
      // Permanent/terminal failures are never transiently retried: throw a
      // PermanentJobFailure (name "UnrecoverableError") so BullMQ moves the
      // job to failed immediately. Everything else is rethrown untouched so
      // BullMQ applies the producer's configured retry/backoff.
      if (kind !== "retry") {
        throw toPermanentFailure(err);
      }
      throw err;
    }
  }

  private logFailure(
    err: unknown,
    kind: JobFailureKind,
    job: WorkerJob<TPayload>,
  ): void {
    const context = { queue: this.queueName, jobId: job.id, code: codeOf(err) };

    if (kind === "permanent") {
      this.logger.error(
        "Worker failed job: permanent payload/validation failure (no retry)",
        { ...context, err },
      );
      return;
    }
    if (kind === "terminal") {
      this.logger.warn(
        "Worker failed job: terminal domain conflict / already-completed / data anomaly (no retry)",
        { ...context, err },
      );
      return;
    }
    this.logger.error(
      "Worker failed job: transient failure (will retry per producer policy)",
      { ...context, err },
    );
  }
}

/**
 * Classify a thrown error into retry semantics:
 * - "permanent" — malformed payload/input; retrying cannot fix it.
 * - "terminal"  — domain conflict / already-completed / data anomaly; the
 *   operation outcome is already determined and retrying cannot change it.
 * - "retry"     — transient connection/timeout, provider/infrastructure, or
 *   unexpected errors; BullMQ applies the producer's attempts + backoff.
 */
export function classifyError(err: unknown): JobFailureKind {
  // A worker that explicitly raised PermanentJobFailure (orphaned job, terminal
  // provider rejection) already decided the outcome is unrecoverable: never
  // transiently retry it. `name` is "UnrecoverableError" so BullMQ's
  // shouldRetryJob moves the job straight to failed.
  if (err instanceof PermanentJobFailure) {
    return "terminal";
  }

  if (err instanceof DomainError) {
    switch (err.code) {
      case "VALIDATION_ERROR":
      case "INVALID_INPUT":
        return "permanent";
      case "DUPLICATE_TRANSACTION":
      case "INVALID_PAYMENT_AMOUNT":
      case "INVALID_CURRENCY":
      case "PAYMENT_VERIFICATION_FAILED":
      case "INVALID_OPERATION":
      case "INVALID_STATE":
      case "INVALID_STATUS_TRANSITION":
      case "ORDER_ALREADY_FULFILLED":
      case "INVALID_RETURN_QUANTITY":
      case "INVALID_RETURN_ITEM":
      case "UNSUPPORTED_OPERATION":
      case "PAYMENT_REQUIRED":
      case "PAYMENT_DECLINED":
      case "REFUND_REQUIRES_REVIEW":
      case "CART_NOT_FOUND":
      case "RESOURCE_NOT_FOUND":
      case "REGION_NOT_FOUND":
      case "OUT_OF_STOCK":
        return "terminal";
      case "INTERNAL_ERROR":
      case "JOB_PROCESSING_ERROR":
      case "EXTERNAL_SERVICE_TIMEOUT":
      case "EXTERNAL_SERVICE_UNAVAILABLE":
      case "EXTERNAL_SERVICE_ERROR":
      case "LOCK_ACQUISITION_FAILED":
      case "LOGISTICS_EVENT_FULFILLMENT_NOT_FOUND":
        return "retry";
      default:
        return "retry";
    }
  }

  // Repository/infrastructure errors (transient by default). Connection and
  // timeout are the canonical transient cases; anything else also retries per
  // policy since a RepositoryError escaping a use case is unexpected.
  if (isRepositoryError(err)) {
    return "retry";
  }

  // Unexpected errors: retry according to the established producer policy.
  return "retry";
}

/** Wrap an original error in a PermanentJobFailure preserving its code/message. */
function toPermanentFailure(err: unknown): PermanentJobFailure {
  if (err instanceof PermanentJobFailure) {
    return err;
  }
  if (err instanceof DomainError) {
    return new PermanentJobFailure(err.code, err.message);
  }
  const code = codeOf(err) ?? "UNKNOWN";
  const message = err instanceof Error ? err.message : "Job failed permanently.";
  return new PermanentJobFailure(code, message);
}

/** Extract a stable error code for logging when one exists. */
function codeOf(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Narrow an unknown error to one carrying a RepositoryErrorCode. */
function isRepositoryError(
  err: unknown,
): err is { code: RepositoryErrorCode } {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return (
    typeof code === "string" &&
    (Object.values(RepositoryErrorCode) as string[]).includes(code)
  );
}
