// apps/api/src/infrastructure/database/repositories/PostgresRoleRepository.ts

// Postgres-backed implementation of IRoleRepository.
//
// Manages admin roles with a JSONB permissions array. Reads parse the array
// back into the domain Role entity; writes serialize it.

import { Role } from "@api-domain-entities/Role";
import type { IRoleRepository } from "@api-domain-interfaces/repositories/IRoleRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type RoleRow = {
  id: string;
  name: string;
  permissions: unknown;
};

function toDomain(row: RoleRow): Role {
  return new Role({
    id: row.id,
    name: row.name,
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
  });
}

export class PostgresRoleRepository implements IRoleRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(id: string): Promise<Role | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("role")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(role: Role): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("role")
        .values({
          id: role.id,
          name: role.name,
          permissions: JSON.stringify(role.permissions),
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            name: role.name,
            permissions: JSON.stringify(role.permissions),
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
