// apps/api/tests/unit/notifications/WorkerRegistryLifecycle.test.ts
//
// UNIT — WorkerRegistry lifecycle contract (the real apps/worker registry).
//
// Regression pin for the BullMQ v6.0.10 start semantics: Worker.run() returns
// a promise that resolves only when the worker's main loop EXITS (on close).
// QueueWorker.start() therefore must NOT await run() — it fire-and-forgets the
// run promise and gates on waitUntilReady() — otherwise WorkerRegistry.startAll()
// blocks forever on the first worker and every later worker never starts. This
// suite proves the registry contract with in-memory fakes (no Redis): startAll()
// calls every registered worker's start() exactly once and in registration
// order, and closeAll() closes every worker exactly once in REVERSE order.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { WorkerRegistry } from "../../../../worker/src/workers/WorkerRegistry";
import type { WorkerLifecycle } from "../../../../worker/src/workers/WorkerRegistry";

class FakeWorker implements WorkerLifecycle {
  readonly name: string;
  startCalls = 0;
  closeCalls = 0;

  constructor(name: string) {
    this.name = name;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

describe("WorkerRegistry — every registered worker starts exactly once", () => {
  it("startAll() starts every worker once, in registration order", async () => {
    const registry = new WorkerRegistry();
    const a = new FakeWorker("A");
    const b = new FakeWorker("B");
    const c = new FakeWorker("C");
    registry.register(a).register(b).register(c);

    expect(registry.size).toBe(3);
    await registry.startAll();

    for (const worker of [a, b, c]) {
      expect(worker.startCalls).toBe(1);
    }
  });

  it("startAll() does not block when a worker's start() awaits its run loop", async () => {
    // Regression: if start() awaited run() (which resolves only on close), this
    // would never reach the second worker. With the fixed contract it resolves.
    const registry = new WorkerRegistry();
    const a = new FakeWorker("A");
    const b = new FakeWorker("B");
    registry.register(a).register(b);
    await registry.startAll();
    expect(a.startCalls).toBe(1);
    expect(b.startCalls).toBe(1);
  });

  it("closeAll() closes every worker exactly once, in reverse order", async () => {
    const registry = new WorkerRegistry();
    const a = new FakeWorker("A");
    const b = new FakeWorker("B");
    registry.register(a).register(b);

    await registry.closeAll();

    expect(a.closeCalls).toBe(1);
    expect(b.closeCalls).toBe(1);
  });

  it("register() refuses a falsy worker", () => {
    const registry = new WorkerRegistry();
    let threw = false;
    try {
      registry.register(null as unknown as WorkerLifecycle);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});