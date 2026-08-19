// apps/api/tests/fakes/InMemoryMoneyAmountRepository.ts
//
// In-memory IMoneyAmountRepository. The swap-variance flow resolves the
// AUTHORITATIVE replacement price (`findRegionalPrice`) from this store, so
// the client can never influence the upcharge/refund amount.

import { MoneyAmount } from "@api/domain/entities/MoneyAmount";
import type { IMoneyAmountRepository } from "@api/domain/interfaces/repositories/IMoneyAmountRepository";
import type { Snapshotable } from "./cloneEntity";
import { cloneValue } from "./cloneEntity";

export class InMemoryMoneyAmountRepository
  implements IMoneyAmountRepository, Snapshotable
{
  private readonly moneyAmounts = new Map<string, MoneyAmount>();

  seed(moneyAmount: MoneyAmount): void {
    this.moneyAmounts.set(moneyAmount.id, moneyAmount);
  }

  get all(): MoneyAmount[] {
    return [...this.moneyAmounts.values()];
  }

  async findById(id: string): Promise<MoneyAmount | null> {
    return this.moneyAmounts.get(id) ?? null;
  }

  async findRegionalPrice(
    variantId: string,
    regionId: string,
  ): Promise<MoneyAmount | null> {
    for (const moneyAmount of this.moneyAmounts.values()) {
      if (
        moneyAmount.variantId === variantId &&
        moneyAmount.regionId === regionId
      ) {
        return moneyAmount;
      }
    }
    return null;
  }

  async save(moneyAmount: MoneyAmount): Promise<void> {
    this.moneyAmounts.set(moneyAmount.id, moneyAmount);
  }

  snapshot(): unknown {
    return cloneValue([...this.moneyAmounts.values()]);
  }

  restore(state: unknown): void {
    this.moneyAmounts.clear();
    for (const moneyAmount of state as MoneyAmount[]) {
      this.moneyAmounts.set(moneyAmount.id, moneyAmount);
    }
  }
}