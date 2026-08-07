// apps/api/src/domain/interfaces/repositories/IRegionRepository.ts
import { Region } from "@api-domain-entities/Region";

// Abstract interface to be implemented by the Data Layer
export interface IRegionRepository {
  findById(id: string): Promise<Region | null>;
  save(region: Region): Promise<void>;
}
