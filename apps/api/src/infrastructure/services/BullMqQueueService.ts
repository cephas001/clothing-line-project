// apps/api/src/infrastructure/services/BullMqQueueService.ts

// Infrastructure implementation of IQueueService backed by BullMQ (Redis).
//
// Responsibilities:
// - enqueueJob: add a job to a named queue, mapping only the options the
//   IQueueService contract defines (jobId, delayMs, priority, attempts,
//   backoff, removeOnComplete, removeOnFail) onto BullMQ's JobsOptions. The
//   supplied jobId (idempotency key) is passed through verbatim. Job payloads
//   are passed through as-is; BullMQ serializes them for Redis storage.
//   Execution-time policies such as timeouts are intentionally NOT represented
//   here — the producer cannot enforce them; they belong to worker processing.
// - getFailedJobs: list a queue's failed jobs (BullMQ "failed" state) mapped to
//   the DeadLetterJob shape the use cases consume.
// - retryJob: move a single failed job back to the waiting list via
//   Job#retry(). Returns false (never throws) when the job does not exist or is
//   not in a retryable failed state.
// - moveToDeadLetterQueue: persist the payload as a durable dead-letter entry
//   in a derived `<queueName>-dlq` queue, keyed by the supplied jobId so a
//   given job can never be recorded twice.
//
// Queue lifecycle / reuse:
// - One BullMQ Queue instance is created per queue name and cached in a Map;
//   repeated operations against the same name reuse the same instance (no new
//   Queue object per addJob call).
// - BullMQ owns its Queue connections (it creates and duplicates clients as it
//   needs). The service therefore receives a BullMQ `connection` CONFIG in its
//   constructor options rather than a shared ioredis client: sharing the
//   session-revocation client with BullMQ would couple two connection
//   lifecycles and is exactly the interference BullMQ's connection semantics
//   are designed to avoid. The composition root derives this config from the
//   project's single REDIS_URL setting, so no configuration values are
//   duplicated — only the connection instance is dedicated to BullMQ.
//
// Error handling:
// - Every queue operation is wrapped so Redis/BullMQ failures are normalized
//   into RepositoryError (CONNECTION / TIMEOUT / UNKNOWN) via the shared
//   toRedisRepositoryError helper used across the Redis infrastructure. A
//   failed enqueue ALWAYS propagates; it is never interpreted as success.
//
// Security: job payloads, secrets, credentials, and tokens are never logged
// and never placed in error messages.

import { Queue } from "bullmq";
import type {
  BackoffOptions,
  ConnectionOptions,
  Job,
  JobsOptions,
} from "bullmq";
import type { IQueueService } from "@api/domain/interfaces/services/IQueueService";
import type { QueueJobOptions, QueueJobState } from "@api/domain/interfaces/services/IQueueService";
import { toRedisRepositoryError } from "@api/infrastructure/redis/errors";
import type { JsonValue } from "@api/domain/shared/json";
import type { DeadLetterJob } from "@api/domain/shared/workflow";

export interface BullMqQueueServiceOptions {
  /**
   * BullMQ Redis connection configuration (host/port/url/password/...),
   * injected by the composition root and derived from the shared REDIS_URL
   * setting. BullMQ creates and manages its own connection(s) from this.
   */
  connection: ConnectionOptions;
}

/** Job name used for every job; the IQueueService contract has no job-name concept. */
const DEFAULT_JOB_NAME = "default";

/** Suffix appended to derive the durable dead-letter queue name. */
const DLQ_SUFFIX = "-dlq";

export class BullMqQueueService implements IQueueService {
  private readonly connection: ConnectionOptions;
  private readonly queues = new Map<string, Queue<unknown, unknown, string>>();

  constructor(options: BullMqQueueServiceOptions) {
    if (!options.connection) {
      throw new Error("BullMqQueueService requires a Redis connection config.");
    }
    this.connection = options.connection;
  }

  async enqueueJob(
    queueName: string,
    payload: unknown,
    options?: QueueJobOptions,
  ): Promise<void> {
    const queue = this.getQueue(queueName);
    await this.run(() => queue.add(DEFAULT_JOB_NAME, payload, this.toBullOptions(options)));
  }

  async getFailedJobs(
    queueName: string,
    offset: number,
    limit: number,
  ): Promise<DeadLetterJob[]> {
    if (limit <= 0) {
      return [];
    }
    const queue = this.getQueue(queueName);
    const jobs = await this.run(() =>
      queue.getJobs(["failed"], offset, offset + limit - 1),
    );
    return jobs.map(toDeadLetterJob);
  }

  async getJobState(
    queueName: string,
    jobId: string,
  ): Promise<QueueJobState | null> {
    const queue = this.getQueue(queueName);
    const job = await this.run(() => queue.getJob(jobId));
    if (!job) {
      return null;
    }
    const state = await this.run(() => job.getState());
    return state as QueueJobState;
  }

  async retryJob(queueName: string, jobId: string): Promise<boolean> {
    const queue = this.getQueue(queueName);
    const job = await this.run(() => queue.getJob(jobId));
    if (!job) {
      return false;
    }
    // Only jobs that actually failed (failedReason populated) are retryable.
    if (!job.failedReason) {
      return false;
    }
    await this.run(() => job.retry());
    return true;
  }

  async moveToDeadLetterQueue(
    queueName: string,
    jobId: string,
    payload: unknown,
  ): Promise<void> {
    const dlq = this.getQueue(this.deadLetterQueueName(queueName));
    // jobId is the idempotency key: re-recording the same job is a no-op for
    // BullMQ (existing job id), so a job can never be durably recorded twice.
    await this.run(() => dlq.add(DEFAULT_JOB_NAME, payload, { jobId }));
  }

  /**
   * Close every cached BullMQ Queue, releasing their Redis connections.
   * Called by the composition root during graceful shutdown; idempotent (a
   * later operation would lazily re-create the queue it needs).
   */
  async close(): Promise<void> {
    const queues = [...this.queues.values()];
    this.queues.clear();
    await Promise.all(queues.map((queue) => this.run(() => queue.close())));
  }

  /** Return the cached BullMQ Queue for a name, creating it on first use. */
  private getQueue(queueName: string): Queue<unknown, unknown, string> {
    if (typeof queueName !== "string" || queueName.length === 0) {
      throw new Error("queueName must be a non-empty string.");
    }
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new Queue<unknown, unknown, string>(queueName, {
        connection: this.connection,
      });
      this.queues.set(queueName, queue);
    }
    return queue;
  }

  private deadLetterQueueName(queueName: string): string {
    return `${queueName}${DLQ_SUFFIX}`;
  }

  /** Map the contract's QueueJobOptions onto BullMQ's JobsOptions. */
  private toBullOptions(options?: QueueJobOptions): JobsOptions {
    if (!options) {
      return {};
    }
    return {
      ...(options.jobId !== undefined ? { jobId: options.jobId } : {}),
      ...(options.delayMs !== undefined ? { delay: options.delayMs } : {}),
      ...(options.priority !== undefined
        ? { priority: toBullPriority(options.priority) }
        : {}),
      ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
      ...(options.backoff ? { backoff: toBullBackoff(options.backoff) } : {}),
      ...(options.removeOnComplete !== undefined
        ? { removeOnComplete: options.removeOnComplete }
        : {}),
      ...(options.removeOnFail !== undefined
        ? { removeOnFail: options.removeOnFail }
        : {}),
    };
  }

  /** Run a queue operation, normalizing BullMQ/Redis failures to RepositoryError. */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      throw toRedisRepositoryError(err);
    }
  }
}

/**
 * Map the contract's priority (number | string) onto BullMQ's numeric priority.
 * Numeric values pass through. String values that parse to a finite number are
 * coerced (e.g. "5"); non-numeric strings such as "high" have no BullMQ
 * equivalent and are dropped rather than crashing enqueue.
 */
function toBullPriority(priority: number | string): number | undefined {
  if (typeof priority === "number") {
    return priority;
  }
  const numeric = Number(priority);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * Map the contract's backoff onto BullMQ's BackoffOptions. `delayMs` becomes
 * BullMQ's `delay`. Unknown backoff types (the interface's string escape hatch)
 * safely fall back to BullMQ's built-in "fixed" strategy.
 */
function toBullBackoff(
  backoff: QueueJobOptions["backoff"],
): BackoffOptions | undefined {
  if (!backoff) {
    return undefined;
  }
  const type =
    backoff.type === "fixed" || backoff.type === "exponential"
      ? backoff.type
      : "fixed";
  return { type, delay: backoff.delayMs };
}

/** Map a BullMQ job (opaque data) to the DeadLetterJob shape. */
function toDeadLetterJob(job: Job<unknown, unknown, string>): DeadLetterJob {
  return {
    id: job.id ?? "",
    name: job.name,
    data: toJsonRecord(job.data),
    failedReason: job.failedReason || undefined,
    attemptsMade: job.attemptsMade,
    timestamp: job.timestamp,
    failedAt: job.finishedOn ?? undefined,
  };
}

/**
 * Narrow an opaque job payload to the DeadLetterJob data shape. Returns
 * undefined when the payload is not a plain object (arrays and primitives have
 * no stable record shape for DeadLetterJob).
 */
function toJsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, JsonValue>;
}
