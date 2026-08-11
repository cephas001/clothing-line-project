// apps/worker/src/workers/QueueWorker.ts

// Reusable BullMQ worker harness for the application's background queues.
//
// Responsibilities:
// - Wrap a BullMQ Worker so consumers receive a typed payload contract
//   (`WorkerJob<TPayload>`) instead of raw BullMQ Job access.
// - Constructing a worker is side-effect-free: BullMQ v6 starts processing
//   only when `run()` is called, so the composition root can build every
//   worker at bootstrap and start them together via start()/WorkerRegistry.
// - Log structured context (queue, jobId, attemptsMade) around every job and
//   classify failures before rethrowing so BullMQ applies the producer's
//   configured retry/backoff:
//     1. permanent payload/validation failures (VALIDATION_ERROR DomainError),
//     2. expected application/domain failures (other DomainError codes),
//     3. transient infrastructure failures (RepositoryError),
//     4. unexpected failures.
//   No failure is swallowed; BullMQ decides retry semantics.
// - Never opens transactions: use cases invoked by handlers own the
//   ITransactionManager boundary.

import { Worker } from "bullmq";
import type { ConnectionOptions, Job, WorkerOptions } from "bullmq";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { RepositoryErrorCode } from "@api/domain/interfaces/shared/errors/RepositoryError";

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
    await this.worker.run();
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
      this.logFailure(err, job);
      throw err;
    }
  }

  private logFailure(err: unknown, job: WorkerJob<TPayload>): void {
    const context = { queue: this.queueName, jobId: job.id };

    if (err instanceof DomainError) {
      if (err.code === "VALIDATION_ERROR") {
        this.logger.error(
          "Worker failed job: permanent payload/validation failure",
          { ...context, code: err.code, err },
        );
      } else {
        this.logger.warn(
          "Worker failed job: expected application/domain failure",
          { ...context, code: err.code, err },
        );
      }
      return;
    }

    if (isRepositoryError(err)) {
      this.logger.error("Worker failed job: transient infrastructure failure", {
        ...context,
        code: err.code,
        err,
      });
      return;
    }

    this.logger.error("Worker failed job: unexpected failure", {
      ...context,
      err,
    });
  }
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
