import { StructuredMeta } from "@api/domain/shared/contracts";

export interface IAuditLogService {
  logAction(
    adminId: string,
    action: string,
    details: StructuredMeta,
  ): Promise<void>;
}
