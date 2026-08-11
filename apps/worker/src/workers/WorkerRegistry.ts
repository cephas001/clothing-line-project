// apps/worker/src/workers/WorkerRegistry.ts

// Lifecycle manager for the application's workers.
//
// The composition root constructs and registers every QueueWorker (construction
// is side-effect-free in BullMQ v6) and then calls startAll() once the process
// is ready. On shutdown it calls closeAll() in reverse registration order so
// the last-started worker closes first.

export interface WorkerLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
}

export class WorkerRegistry {
  private readonly workers: WorkerLifecycle[] = [];

  register(worker: WorkerLifecycle): this {
    if (!worker) {
      throw new Error("WorkerRegistry.register requires a worker instance.");
    }
    this.workers.push(worker);
    return this;
  }

  get size(): number {
    return this.workers.length;
  }

  async startAll(): Promise<void> {
    for (const worker of this.workers) {
      await worker.start();
    }
  }

  /**
   * Stop every worker, best-effort. Every worker is given a chance to close
   * even if an earlier close throws; the first error is then rethrown so the
   * process can exit with a non-zero status.
   */
  async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const worker of [...this.workers].reverse()) {
      try {
        await worker.close();
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  }
}
