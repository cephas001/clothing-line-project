// apps/api/src/infrastructure/database/repositories/PostgresCategoryReadRepository.ts

// Postgres-backed implementation of ICategoryReadRepository.
//
// Read-only projection for the storefront category tree. When
// includeDescendants is false only root categories (parent_category_id IS
// NULL) are returned; otherwise the full flat set is returned and the
// hierarchical structure is implied by each Category's parentCategoryId.

import { Category } from "@api/domain/entities/Category";
import type { ICategoryReadRepository } from "@api-domain-interfaces/repositories/ICategoryReadRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type CategoryRow = {
  id: string;
  name: string;
  parent_category_id: string | null;
  created_at: string;
};

function toDomain(row: CategoryRow): Category {
  return new Category({
    id: row.id,
    name: row.name,
    parentCategoryId: row.parent_category_id,
    createdAt: row.created_at,
  });
}

export class PostgresCategoryReadRepository implements ICategoryReadRepository {
  constructor(private readonly context: TransactionContext) {}

  async getTree(options: {
    includeDescendants: boolean;
  }): Promise<Category[]> {
    try {
      const query = this.context.getDb().selectFrom("category").selectAll();

      const rows = options.includeDescendants
        ? await query.execute()
        : await query.where("parent_category_id", "is", null).execute();

      return rows.map(toDomain);
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
