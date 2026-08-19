// apps/api/tests/fakes/FakeQueueService.ts
//
// In-memory IQueueService. Records every enqueued job so tests can assert the
// queue contract: the typed internal payload, the queue name, and the
// idempotency jobId (= transactionReference).
//
// By default the fake ENFORCES the jobId idempotency guarantee: enqueuing a
// second job with an already-used jobId surfaces RepositoryErrorCode.DUPLICATE
// — exactly what QueuePaymentEventUseCase maps into an idempotent success
// (PAYMENT_EVENT_ALREADY_QUEUED) instead of a duplicate job.
//
// `jobStates` models the queue's observable job lifecycle for L8-R PART 14
// (sweep DUPLICATE resolution): every recorded job defaults to a LIVE
// `waiting` state, and tests can set a state (e.g. "failed") to model an
// unprovable/stale job.

import type { DeadLetterJob } from "@api/domain/shared/workflow";
import type {
  IQueueService,
  QueueJobOptions,
  QueueJobState,
} from "@api/domain/interfaces/services/IQueueService";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface RecordedJob {
  queueName: string;
  payload: unknown;
  options?: QueueJobOptions;
}

export class FakeQueueService implements IQueueService {
  readonly jobs: RecordedJob[] = [];
  readonly deadLetters: RecordedJob[] = [];
  /** Observable lifecycle state per jobId (defaults to LIVE "waiting"). */
  readonly jobStates = new Map<string, QueueJobState>();

  /** When set, every enqueue throws this error. */
  failWith?: Error;
  /** When set, every enqueue throws a RepositoryError with this code. */
  failWithCode?: RepositoryErrorCode;

  constructor(private readonly enforceJobIdIdempotency = true) {}

  async enqueueJob(
    queueName: string,
    payload: unknown,
    options?: QueueJobOptions,
  ): Promise<void> {
    if (this.failWithCode) {
      throw this.repositoryError(this.failWithCode, "Queue service failure.");
    }
    if (this.failWith) {
      throw this.failWith;
    }

    if (options?.jobId && this.enforceJobIdIdempotency) {
      const existing = this.jobs.find((j) => j.options?.jobId === options.jobId);
      if (existing) {
        throw this.repositoryError(
          RepositoryErrorCode.DUPLICATE,
          `A job with jobId ${options.jobId} already exists.`,
        );
      }
    }

    this.jobs.push({ queueName, payload, options });
    if (options?.jobId) {
      this.jobStates.set(options.jobId, "waiting");
    }
  }

  async getJobState(
    _queueName: string,
    jobId: string,
  ): Promise<QueueJobState | null> {
    return this.jobStates.get(jobId) ?? null;
  }

  async getFailedJobs(
    _queueName: string,
    _offset: number,
    _limit: number,
  ): Promise<DeadLetterJob[]> {
    return [];
  }

  async retryJob(_queueName: string, _jobId: string): Promise<boolean> {
    return true;
  }

  async moveToDeadLetterQueue(
    queueName: string,
    jobId: string,
    payload: unknown,
  ): Promise<void> {
    this.deadLetters.push({ queueName, payload, options: { jobId } });
  }

  /** Jobs enqueued to the payment-events queue, in order. */
  paymentEventJobs(): RecordedJob[] {
    return this.jobs.filter((j) => j.queueName === "payment-events-queue");
  }

  private repositoryError(
    code: RepositoryErrorCode,
    message: string,
  ): RepositoryError {
    const error = new Error(message) as RepositoryError;
    error.name = "RepositoryError";
    error.code = code;
    return error;
  }
}