// apps/api/src/infrastructure/services/PinoLogger.ts

// Pino implementation of ILogger.
//
// Emits structured JSON logs suitable for production ingestion. Every ILogger
// call maps 1:1 onto a Pino log record: the message becomes `msg` and the
// optional StructuredMeta is passed through as structured fields — never as
// string interpolation. Pino's native error serialization preserves `name`,
// `message`, `stack` (and enumerable props such as `code`) for Error values,
// so errors are never rendered as `[object Object]`.
//
// Redaction: a conservative default path list masks common secrets
// (passwords, tokens, authorization headers, API keys, payment credentials)
// in every emitted record. Override via the `redact` option.
//
// OpenTelemetry integration: this logger is a passive CONSUMER of the tracing
// SDK. It reads the currently active span via `@opentelemetry/api` at LOG TIME
// and, when a valid sampled span exists, enriches each record with `trace_id`
// and `span_id`. It never creates spans and never imports the SDK — only the
// API surface — so it stays a lightweight infrastructure implementation.
//
// When no active span exists (no request in flight, telemetry disabled, or a
// non-sampled span) the IDs are omitted; no fake IDs are generated and no
// exception is thrown.

import { trace, TraceFlags } from "@opentelemetry/api";
import pino from "pino";
import type { Logger } from "pino";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { StructuredMeta } from "@api/domain/shared/contracts";

const DEFAULT_REDACT: string[] = [
  "password",
  "*.password",
  "passwordHash",
  "passwordResetTokenHash",
  "token",
  "*.token",
  "accessToken",
  "refreshToken",
  "authorization",
  "*.authorization",
  "apiKey",
  "api_key",
  "*.apiKey",
  "secret",
  "secretKey",
  "*.secret",
  "cardNumber",
  "cvv",
  "x-api-key",
  "x-payment-signature",
];

export interface PinoLoggerOptions {
  /** Minimum level to emit. Defaults to "info". */
  level?: pino.Level;
  /** Base fields attached to every record. Defaults to Pino's (pid, hostname). */
  base?: pino.LoggerOptions["base"];
  /** Redaction paths. Defaults to a conservative secret-masking list. */
  redact?: string[];
}

/**
 * Render an Error value that appears anywhere in the structured metadata as a
 * plain JSON object preserving its name, message, stack and enumerable
 * properties (e.g. `code`). Pino's native `err` serializer is still preferred
 * for the conventional `err` key; this covers errors under any other key so
 * they are never reduced to `[object Object]` or a bare `{}`.
 */
function normalizeError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
  for (const key of Object.keys(err)) {
    if (key === "name" || key === "message" || key === "stack") {
      continue;
    }
    out[key] = (err as unknown as Record<string, unknown>)[key];
  }
  return out;
}

export class PinoLogger implements ILogger {
  private readonly logger: Logger;

  constructor(options: PinoLoggerOptions = {}) {
    this.logger = pino({
      level: options.level ?? "info",
      base: options.base,
      redact: options.redact ?? DEFAULT_REDACT,
    });
  }

  info(message: string, meta?: StructuredMeta): void {
    const enriched = this.enrichWithTraceContext(meta);
    if (enriched) {
      this.logger.info(this.serializeMeta(enriched), message);
    } else {
      this.logger.info(message);
    }
  }

  warn(message: string, meta?: StructuredMeta): void {
    const enriched = this.enrichWithTraceContext(meta);
    if (enriched) {
      this.logger.warn(this.serializeMeta(enriched), message);
    } else {
      this.logger.warn(message);
    }
  }

  error(message: string, meta?: StructuredMeta): void {
    const enriched = this.enrichWithTraceContext(meta);
    if (enriched) {
      this.logger.error(this.serializeMeta(enriched), message);
    } else {
      this.logger.error(message);
    }
  }

  /**
   * Enrich the record with the active span's `trace_id` / `span_id`.
   *
   * Resolved at LOG TIME (not construction) because the active span changes per
   * request/background operation. Returns the original meta unchanged when no
   * valid sampled span is active, so existing behavior is preserved exactly.
   */
  private enrichWithTraceContext(meta?: StructuredMeta): StructuredMeta | undefined {
    const span = trace.getActiveSpan();
    if (!span) {
      return meta;
    }
    const spanContext = span.spanContext();
    if (spanContext.traceFlags !== TraceFlags.SAMPLED) {
      return meta;
    }
    return {
      ...(meta ?? {}),
      trace_id: spanContext.traceId,
      span_id: spanContext.spanId,
    };
  }

  private serializeMeta(meta: StructuredMeta): StructuredMeta {
    let needsNormalization = false;
    for (const value of Object.values(meta)) {
      if (value instanceof Error) {
        needsNormalization = true;
        break;
      }
    }
    if (!needsNormalization) {
      return meta;
    }

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(meta)) {
      if (key === "err") {
        // Pino's native err serializer produces a richer record.
        out[key] = value;
      } else {
        out[key] = value instanceof Error ? normalizeError(value) : value;
      }
    }
    return out;
  }
}
