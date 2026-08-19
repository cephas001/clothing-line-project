// apps/api/tests/fakes/InMemoryRegionRepository.ts

// In-memory IRegionRepository keyed by region id.

import { Region } from "@api/domain/entities/Region";
import type { IRegionRepository } from "@api/domain/interfaces/repositories/IRegionRepository";

export class InMemoryRegionRepository implements IRegionRepository {
  private readonly regions = new Map<string, Region>();

  seed(region: Region): void {
    this.regions.set(region.id, region);
  }

  async findById(id: string): Promise<Region | null> {
    return this.regions.get(id) ?? null;
  }

  async save(region: Region): Promise<void> {
    this.regions.set(region.id, region);
  }
}