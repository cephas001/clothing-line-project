// apps/api/src/domain/interfaces/repositories/IPromotionRepository.ts

import { Promotion } from "@api/domain/entities/Promotion";

// Abstract interface to be implemented by the Data Layer
export interface IPromotionRepository {
  findById(id: string): Promise<Promotion | null>;

  findByCode(code: string): Promise<Promotion | null>;

  save(promotion: Promotion): Promise<void>;
}
