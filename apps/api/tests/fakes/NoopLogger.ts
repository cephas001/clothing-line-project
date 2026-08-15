// apps/api/tests/fakes/NoopLogger.ts

// Silent ILogger implementation. Use cases log through the interface; tests
// assert on state, not log noise.

import type { StructuredMeta } from "@api/domain/shared/contracts";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";

export class NoopLogger implements ILogger {
  info(_message: string, _meta?: StructuredMeta): void {}
  warn(_message: string, _meta?: StructuredMeta): void {}
  error(_message: string, _meta?: StructuredMeta): void {}
}