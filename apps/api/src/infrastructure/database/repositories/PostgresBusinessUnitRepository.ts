// apps/api/src/infrastructure/database/repositories/PostgresBusinessUnitRepository.ts

// Postgres-backed implementation of IBusinessUnitRepository.
//
// Persists BusinessUnitRecord values with members stored as a JSONB snapshot.
// The schema has no unique constraint on registration_number or name, so
// duplicate detection relies on application logic and surfaces via the shared
// error mapping when applicable.

import type {
  BusinessUnitMemberRecord,
  BusinessUnitRecord,
} from "@api/domain/shared/contracts";
import type { IBusinessUnitRepository } from "@api-domain-interfaces/repositories/IBusinessUnitRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type BusinessUnitRow = {
  id: string;
  name: string;
  registration_number: string;
  sales_channel_id: string;
  members: unknown;
  created_at: string;
};

function toDomain(row: BusinessUnitRow): BusinessUnitRecord {
  return {
    id: row.id,
    name: row.name,
    registrationNumber: row.registration_number,
    salesChannelId: row.sales_channel_id,
    members: Array.isArray(row.members)
      ? (row.members as BusinessUnitMemberRecord[])
      : [],
    createdAt: row.created_at,
  };
}

export class PostgresBusinessUnitRepository implements IBusinessUnitRepository {
  constructor(private readonly context: TransactionContext) {}

  async findByRegistrationNumber(
    registrationNumber: string,
  ): Promise<BusinessUnitRecord | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("business_unit")
        .selectAll()
        .where("registration_number", "=", registrationNumber)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByName(name: string): Promise<BusinessUnitRecord | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("business_unit")
        .selectAll()
        .where("name", "=", name)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(businessUnit: BusinessUnitRecord): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("business_unit")
        .values({
          id: businessUnit.id,
          name: businessUnit.name,
          registration_number: businessUnit.registrationNumber,
          sales_channel_id: businessUnit.salesChannelId,
          members: JSON.stringify(businessUnit.members),
          created_at: businessUnit.createdAt,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            name: businessUnit.name,
            registration_number: businessUnit.registrationNumber,
            sales_channel_id: businessUnit.salesChannelId,
            members: JSON.stringify(businessUnit.members),
            created_at: businessUnit.createdAt,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
