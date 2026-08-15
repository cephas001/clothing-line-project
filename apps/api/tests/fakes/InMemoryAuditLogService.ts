// apps/api/tests/fakes/InMemoryAuditLogService.ts

// Records audit entries in memory so tests can assert that financial events
// were audited (without a Postgres dependency). logAction is non-blocking in
// the use cases; this fake resolves immediately.

import type { StructuredMeta } from "@api/domain/shared/contracts";
import type { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";

export interface AuditEntry {
  actorId: string;
  action: string;
  details: StructuredMeta;
}

export class InMemoryAuditLogService implements IAuditLogService {
  readonly entries: AuditEntry[] = [];

  async logAction(
    actorId: string,
    action: string,
    details: StructuredMeta,
  ): Promise<void> {
    this.entries.push({ actorId, action, details });
  }

  actions(): string[] {
    return this.entries.map((entry) => entry.action);
  }
}