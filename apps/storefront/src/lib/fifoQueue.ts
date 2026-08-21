// apps/storefront/src/lib/fifoQueue.ts
//
// Minimal FIFO serialization queue (F6 Slice 1 — mutation sequencing safety).
//
// Cart mutations MUST run one-at-a-time in the order they were requested so
// reconcile order matches mutation order and each quantity target is computed
// against the last reconciled projection instead of an interleaved one. A
// rejected task never starves later ones: the chain re-arms on failure so
// subsequent mutations are always able to run.

export interface FifoQueue {
  /** Run `task` after every previously enqueued task has settled. */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
}

export function createFifoQueue(): FifoQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}