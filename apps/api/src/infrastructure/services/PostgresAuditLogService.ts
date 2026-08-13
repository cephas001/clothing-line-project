// apps/api/src/infrastructure/services/PostgresAuditLogService.ts

// Postgres-backed implementation of IAuditLogService.
//
// Appends a row to `audit_log` for every emitted audit action. The insert is
// executed against the connection resolved by the shared TransactionContext:
// when the use case runs inside an ITransactionManager unit of work the audit
// row joins that same transaction (committing or rolling back with it); outside
// a transaction it uses the pooled application connection. The service never
// opens its own transaction and never commits independently.
//
// Error handling follows the Postgres repository convention: driver failures
// are normalized to RepositoryError via toRepositoryError and rethrown — never
// swallowed and never converted into success. Whether an audit failure is
// best-effort or fatal is a use-case concern (the existing callers catch and
// warn); this layer does not decide.
//
// The service logs nothing of its own, and therefore never risks exposing
// payload data (passwords, tokens, payment credentials, authorization headers).

import type { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import type { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import type { StructuredMeta } from "@api/domain/shared/contracts";
import { TransactionContext } from "../database/transaction/TransactionContext";
import { toRepositoryError } from "../database/repositories/errorMapping";

export class PostgresAuditLogService implements IAuditLogService {
  constructor(
    private readonly context: TransactionContext,
    private readonly idGenerator: IIdGenerator,
  ) {}

  async logAction(
    adminId: string,
    action: string,
    details: StructuredMeta,
  ): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("audit_log")
        .values({
          id: this.idGenerator.generate(),
          actor_id: adminId,
          action,
          // JSONB columns are serialized on write (the pg driver does not
          // auto-serialize objects; see the Postgres repository convention).
          details: JSON.stringify(details),
        })
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
