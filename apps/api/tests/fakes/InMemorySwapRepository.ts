// apps/api/tests/fakes/InMemorySwapRepository.ts
//
// In-memory ISwapRepository mirroring the database guards:
//
//   - UNIQUE(natural_key) — the deterministic business identity of a swap
//     request. Re-running the same request (same order + line item + variant +
//     quantity) collides instead of creating a duplicate swap and a second
//     gateway payment/refund.
//
// `save()` reconciles an EXISTING row (by id) in place so state transitions
// (pending -> awaiting_payment / refund_dispatched / even_exchange /
// completed) persist without uniqueness collisions.

import { Swap } from "@api/domain/entities/Swap";
import type { ISwapRepository } from "@api/domain/interfaces/repositories/ISwapRepository";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { Snapshotable } from "./cloneEntity";
import { cloneValue } from "./cloneEntity";

export class InMemorySwapRepository implements ISwapRepository, Snapshotable {
  private readonly swaps = new Map<string, Swap>();

  seed(swap: Swap): void {
    this.swaps.set(swap.id, swap);
  }

  get all(): Swap[] {
    return [...this.swaps.values()];
  }

  async findById(id: string): Promise<Swap | null> {
    return this.swaps.get(id) ?? null;
  }

  async findByNaturalKey(naturalKey: string): Promise<Swap | null> {
    for (const swap of this.swaps.values()) {
      if (swap.naturalKey === naturalKey) {
        return swap;
      }
    }
    return null;
  }

  async save(swap: Swap): Promise<void> {
    const existing = this.swaps.get(swap.id);
    if (existing) {
      // Reconcile in place (same swap row across state transitions).
      this.swaps.set(swap.id, swap);
      return;
    }

    const duplicateKey = [...this.swaps.values()].some(
      (s) => s.naturalKey === swap.naturalKey,
    );
    if (duplicateKey) {
      throw this.duplicate(
        `UNIQUE(natural_key) violated for ${swap.naturalKey}.`,
      );
    }

    this.swaps.set(swap.id, swap);
  }

  snapshot(): unknown {
    return cloneValue([...this.swaps.values()]);
  }

  restore(state: unknown): void {
    this.swaps.clear();
    for (const swap of state as Swap[]) {
      this.swaps.set(swap.id, swap);
    }
  }

  private duplicate(message: string): RepositoryError {
    const error = new Error(message) as RepositoryError;
    error.name = "RepositoryError";
    error.code = RepositoryErrorCode.DUPLICATE;
    return error;
  }
}