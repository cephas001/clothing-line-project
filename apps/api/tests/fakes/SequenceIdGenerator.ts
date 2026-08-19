// apps/api/tests/fakes/SequenceIdGenerator.ts

// Deterministic, collision-free id generator for use cases under test.
// IDs are sequential (`id-1`, `id-2`, ...) so expectations are repeatable.

import type { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";

export class SequenceIdGenerator implements IIdGenerator {
  private counter = 0;

  generate(): string {
    this.counter += 1;
    return `id-${this.counter}`;
  }
}