// apps/api/tests/fakes/RecordingLogger.ts

// ILogger implementation that captures every emitted (level, message, meta)
// triple so tests can assert on STRUCTURED OBSERVABILITY EVENTS (the `event`
// field in the meta) without asserting on log noise.

import type { StructuredMeta } from "@api/domain/shared/contracts";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";

export interface RecordedLog {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta?: StructuredMeta;
}

export class RecordingLogger implements ILogger {
  public readonly logs: RecordedLog[] = [];

  debug(message: string, meta?: StructuredMeta): void {
    this.logs.push({ level: "debug", message, meta });
  }

  info(message: string, meta?: StructuredMeta): void {
    this.logs.push({ level: "info", message, meta });
  }

  warn(message: string, meta?: StructuredMeta): void {
    this.logs.push({ level: "warn", message, meta });
  }

  error(message: string, meta?: StructuredMeta): void {
    this.logs.push({ level: "error", message, meta });
  }

  /** Every log whose meta carries the given structured `event` name. */
  eventsOf(event: string): RecordedLog[] {
    return this.logs.filter(
      (log) =>
        log.meta !== undefined &&
        (log.meta as Record<string, unknown>).event === event,
    );
  }

  /** The meta value for a structured field of the first matching event. */
  fieldOf(event: string, field: string): unknown {
    const log = this.eventsOf(event)[0];
    if (!log || log.meta === undefined) {
      return undefined;
    }
    return (log.meta as Record<string, unknown>)[field];
  }
}
