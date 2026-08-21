// apps/storefront/tests/unit/fifoQueue.test.ts
//
// F6 Slice 1 — mutation sequencing safety. Cart mutations MUST run one at a
// time in request order (FIFO) so reconcile order matches mutation order; a
// failed task must never starve the tasks queued behind it.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { createFifoQueue } from "../../src/lib/fifoQueue";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yield past the queue's continuation microjobs before asserting order. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createFifoQueue", () => {
  it("runs tasks strictly in enqueue order, one at a time", async () => {
    const queue = createFifoQueue();
    const order: string[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

    const results = [
      queue.enqueue(async () => {
        order.push("a:start");
        await gates[0].promise;
        order.push("a:end");
      }),
      queue.enqueue(async () => {
        order.push("b:start");
        await gates[1].promise;
        order.push("b:end");
      }),
      queue.enqueue(async () => {
        order.push("c:start");
        await gates[2].promise;
        order.push("c:end");
      }),
    ];

    // Nothing has run yet beyond the first task starting.
    await tick();
    expect(order).toEqual(["a:start"]);

    gates[0].resolve(undefined);
    await results[0];
    await tick();
    expect(order).toEqual(["a:start", "a:end", "b:start"]);

    gates[1].resolve(undefined);
    await results[1];
    await tick();
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start"]);

    gates[2].resolve(undefined);
    await results[2];
    await tick();
    expect(order).toEqual([
      "a:start",
      "a:end",
      "b:start",
      "b:end",
      "c:start",
      "c:end",
    ]);
  });

  it("preserves each task's resolved value", async () => {
    const queue = createFifoQueue();
    const first = await queue.enqueue(async () => 1);
    const second = await queue.enqueue(async () => "two");
    expect(first).toBe(1);
    expect(second).toBe("two");
  });

  it("propagates a task's rejection to its own caller", async () => {
    const queue = createFifoQueue();
    let rejection: unknown = null;
    try {
      await queue.enqueue(async () => {
        throw new Error("boom");
      });
    } catch (err) {
      rejection = err;
    }
    expect((rejection as Error).message).toBe("boom");
  });

  it("a rejected task never starves later tasks (chain re-arms)", async () => {
    const queue = createFifoQueue();
    const ran: string[] = [];

    const failing = queue.enqueue(async () => {
      throw new Error("mutation failed");
    });
    const following = queue.enqueue(async () => {
      ran.push("after-failure");
    });

    let rejection: unknown = null;
    try {
      await failing;
    } catch (err) {
      rejection = err;
    }
    await following;

    expect((rejection as Error).message).toBe("mutation failed");
    expect(ran).toEqual(["after-failure"]);
  });

  it("serializes overlapping mutations: the second starts only after the first settles", async () => {
    const queue = createFifoQueue();
    let inFlight = 0;
    let maxConcurrent = 0;

    const tasks = [1, 2, 3, 4].map((n) =>
      queue.enqueue(async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5 * n));
        inFlight -= 1;
      }),
    );
    await Promise.all(tasks);

    expect(maxConcurrent).toBe(1);
  });
});
