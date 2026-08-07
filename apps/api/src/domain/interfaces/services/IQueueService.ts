// apps/api/src/domain/interfaces/services/IQueueService.ts
export interface QueueJobOptions {
  delayMs?: number;
  priority?: number | string;
  attempts?: number;
  backoff?: {
    type: "fixed" | "exponential" | string;
    delayMs: number;
  };
  timeoutMs?: number;
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
