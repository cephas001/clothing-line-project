// apps/api/src/infrastructure/database/repositories/PostgresSalesChannelRepository.ts

// Postgres-backed implementation of ISalesChannelRepository.
//
// Manages sales channels. created_at is a DB default, so the entity's
// createdAt is only authoritative on reads.

import { SalesChannel } from "@api/domain/entities/SalesChannel";
import type { ISalesChannelRepository } from "@api-domain-interfaces/repositories/ISalesChannelRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type SalesChannelRow = {
  id: string;
  name: string;
  description: string | null;
  is_disabled: boolean;
  created_at: string;
};

function toDomain(row: SalesChannelRow): SalesChannel {
  return new SalesChannel({
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    isDisabled: row.is_disabled,
    createdAt: row.created_at,
  });
}

export class PostgresSalesChannelRepository implements ISalesChannelRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(channelId: string): Promise<SalesChannel | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("sales_channel")
        .selectAll()
        .where("id", "=", channelId)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(channel: SalesChannel): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("sales_channel")
        .values({
          id: channel.id,
          name: channel.name,
          description: channel.description,
          is_disabled: channel.isDisabled,
          created_at: channel.createdAt,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            name: channel.name,
            description: channel.description,
            is_disabled: channel.isDisabled,
            created_at: channel.createdAt,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
