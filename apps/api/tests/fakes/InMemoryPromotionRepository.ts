// apps/api/tests/fakes/InMemoryPromotionRepository.ts

// In-memory IPromotionRepository keyed by promotion id, with a case-normalized
// code lookup (the apply/create use cases normalize codes to uppercase, so a
// store that matches on the normalized code mirrors the real repository).

import { Promotion } from "@api/domain/entities/Promotion";
import type { IPromotionRepository } from "@api/domain/interfaces/repositories/IPromotionRepository";

export class InMemoryPromotionRepository implements IPromotionRepository {
  private readonly promotions = new Map<string, Promotion>();

  seed(promotion: Promotion): void {
    this.promotions.set(promotion.id, promotion);
  }

  get all(): Promotion[] {
    return [...this.promotions.values()];
  }

  async findById(id: string): Promise<Promotion | null> {
    return this.promotions.get(id) ?? null;
  }

  async findByCode(code: string): Promise<Promotion | null> {
    const normalized = code.trim().toUpperCase();
    for (const promotion of this.promotions.values()) {
      if (promotion.code === normalized) {
        return promotion;
      }
    }
    return null;
  }

  async save(promotion: Promotion): Promise<void> {
    this.promotions.set(promotion.id, promotion);
  }
}