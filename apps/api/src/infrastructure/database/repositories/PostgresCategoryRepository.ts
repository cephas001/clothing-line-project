// apps/api/src/infrastructure/database/repositories/PostgresCategoryRepository.ts

// Postgres-backed implementation of ICategoryRepository.
//
// Manages the self-referential category tree: children are found by
// parent_category_id (NULL selects root categories). created_at is a DB
// default, so the entity's createdAt is only authoritative on reads.

import { Category } from "@api-domain-entities/Category";
import type { ICategoryRepository } from "@api-domain-interfaces/repositories/ICategoryRepository";
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

export class PostgresCategoryRepository implements ICategoryRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(id: string): Promise<Category | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("category")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findChildren(parentCategoryId: string | null): Promise<Category[]> {
    try {
      const rows = parentCategoryId
        ? await this.context
            .getDb()
            .selectFrom("category")
            .selectAll()
            .where("parent_category_id", "=", parentCategoryId)
            .execute()
        : await this.context
            .getDb()
            .selectFrom("category")
            .selectAll()
            .where("parent_category_id", "is", null)
            .execute();

      return rows.map(toDomain);
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByName(name: string): Promise<Category | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("category")
        .selectAll()
        .where("name", "=", name)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(category: Category): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("category")
        .values({
          id: category.id,
          name: category.name,
          parent_category_id: category.parentCategoryId,
          created_at: category.createdAt,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            name: category.name,
            parent_category_id: category.parentCategoryId,
            created_at: category.createdAt,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.context
        .getDb()
        .deleteFrom("category")
        .where("id", "=", id)
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
