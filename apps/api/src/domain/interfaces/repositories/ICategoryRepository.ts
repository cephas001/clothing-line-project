// apps/api/src/domain/interfaces/repositories/ICategoryRepository.ts

import { Category } from "@api-domain-entities/Category";

export interface ICategoryRepository {
  findById(id: string): Promise<Category | null>;

  findChildren(parentCategoryId: string | null): Promise<Category[]>;

  findByName(name: string): Promise<Category | null>;

  save(category: Category): Promise<void>;

  delete(id: string): Promise<void>;
}
