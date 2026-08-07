// apps/api/src/domain/interfaces/repositories/ITaxCategoryRepository.ts

import { TaxCategory } from "@api/domain/entities/TaxCategory";

export interface ITaxCategoryRepository {
  findById(id: string): Promise<TaxCategory | null>;
  findByNameAndRegion(
    name: string,
    regionId: string,
  ): Promise<TaxCategory | null>;
  save(taxCategory: TaxCategory): Promise<void>;
}
