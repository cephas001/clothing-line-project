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

// Abstract interface to be implemented by the Infrastructure Layer
export interface IQueueService {
  enqueueJob(
    queueName: string,
    payload: unknown,
    options?: QueueJobOptions,
  ): Promise<void>;
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
