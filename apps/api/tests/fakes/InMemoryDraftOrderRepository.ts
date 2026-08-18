// apps/api/tests/fakes/InMemoryDraftOrderRepository.ts
//
// In-memory IDraftOrderRepository keyed by draft order id. Supports the
// Snapshotable contract so the rollback/atomicity tests (outbox-migrated
// producers) can verify the draft order + notification intent commit together.

import { DraftOrderRecord } from "@api/domain/shared/contracts";
import type { IDraftOrderRepository } from "@api/domain/interfaces/repositories/IDraftOrderRepository";
import type { Snapshotable } from "./cloneEntity";
import { cloneValue } from "./cloneEntity";

export class InMemoryDraftOrderRepository
  implements IDraftOrderRepository, Snapshotable
{
  private readonly orders = new Map<string, DraftOrderRecord>();

  seed(draftOrder: DraftOrderRecord): void {
    this.orders.set(draftOrder.id, draftOrder);
  }

  get all(): DraftOrderRecord[] {
    return [...this.orders.values()];
  }

  async save(draftOrder: DraftOrderRecord): Promise<void> {
    this.orders.set(draftOrder.id, draftOrder);
  }

  async findById(draftOrderId: string): Promise<DraftOrderRecord | null> {
    return this.orders.get(draftOrderId) ?? null;
  }

  snapshot(): unknown {
    return cloneValue([...this.orders.values()]);
  }

  restore(state: unknown): void {
    this.orders.clear();
    for (const record of state as DraftOrderRecord[]) {
      this.orders.set(record.id, record);
    }
  }
}