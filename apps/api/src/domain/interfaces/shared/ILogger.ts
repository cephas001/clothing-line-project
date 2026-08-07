import { StructuredMeta } from "@api/domain/shared/contracts";

// apps/api/src/shared/Logger.ts

export interface ILogger {
  info(message: string, meta?: StructuredMeta): void;
  warn(message: string, meta?: StructuredMeta): void;
  error(message: string, meta?: StructuredMeta): void;
}
