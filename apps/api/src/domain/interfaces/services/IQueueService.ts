// apps/api/src/domain/interfaces/services/IQueueService.ts

/**
 * Producer-controlled job options. This contract only represents capabilities
 * the producer can actually control at enqueue time.
 *
 * Execution-time policies (e.g. a per-job execution timeout) are deliberately
 * NOT represented here: they are enforced by workers at processing time, and a
 * producer option for them would falsely imply the producer enforces them.
 */
export interface QueueJobOptions {
  /**
   * Explicit job identifier, used as an idempotency key. Supplying the same
   * jobId for the same queue must not create a duplicate job (BullMQ treats an
   * existing id as a no-op). The application decides what constitutes the
   * idempotency key (e.g. a transaction reference).
   */
  jobId?: string;
  delayMs?: number;
  priority?: number | string;
  attempts?: number;
  backoff?: {
    type: "fixed" | "exponential" | string;
    delayMs: number;
  };
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
}

import { DeadLetterJob } from "@api/domain/shared/workflow";

/**
 * The lifecycle state of an existing queue job, as observed by the queue
 * contract (L8-R PART 14). Only a LIVE state (`waiting` | `delayed` |
 * `active`) proves a job will actually be delivered; `completed`/`failed`/
 * `paused`/`waiting-children`/`unknown` do not. `null` means no such job
 * exists.
 */
export type QueueJobState =
  | "waiting"
  | "delayed"
  | "active"
  | "waiting-children"
  | "completed"
  | "failed"
  | "paused"
  | "unknown";

// Abstract interface to be implemented by the Infrastructure Layer
export interface IQueueService {
  enqueueJob(
    queueName: string,
    payload: unknown,
    options?: QueueJobOptions,
  ): Promise<void>;
  /**
   * Resolve the lifecycle state of an existing job by its deterministic id,
   * or `null` when no such job exists. Used to prove that a DUPLICATE enqueue
   * collision refers to a LIVE job (so the row can be marked queued) rather
   * than an unprovable/stale one (which must fail closed). Errors surface as
   * RepositoryError.
   */
  getJobState(queueName: string, jobId: string): Promise<QueueJobState | null>;
  getFailedJobs(
    queueName: string,
    offset: number,
    limit: number,
  ): Promise<DeadLetterJob[]>;
  retryJob(queueName: string, jobId: string): Promise<boolean>;
  moveToDeadLetterQueue(
    queueName: string,
    jobId: string,
    payload: unknown,
  ): Promise<void>;
}
