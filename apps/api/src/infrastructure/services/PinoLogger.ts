// apps/api/src/infrastructure/services/PinoLogger.ts

// Pino implementation of ILogger.
//
// Emits structured JSON logs suitable for production ingestion. Every ILogger
// call maps 1:1 onto a Pino log record: the message becomes `msg` and the
// optional StructuredMeta is passed through as structured fields — never as
// string interpolation. `debug` maps to Pino's `debug` level and is therefore
// SUPPRESSED by the default "info" threshold (LOG_LEVEL) — routine low-signal
// telemetry (e.g. product read cache hits/misses) lives at debug on purpose.
// Pino's native error serialization preserves `name`, `message`, `stack` (and
// enumerable props such as `code`) for Error values, so errors are never
// rendered as `[object Object]`.
//
// Redaction: a conservative default path list masks common secrets
// (passwords, tokens, authorization headers, API keys, payment credentials)
// in every emitted record. Override via the `redact` option. Redaction is
// applied by Pino BEFORE the pretty transport, so human-readable development
// output can never expose a redacted field.
//
// Development pretty output: when `pretty` is true, the logger writes through
// a pino-pretty transport (worker thread) that renders one line per record as
// `[TIME] LEVEL: [component] message {structured fields}`. This is a pure
// PRESENTATION concern — the record still carries the same redacted fields,
// timestamps, levels, and context, and production (pretty: false) keeps
// emitting machine-readable JSON. `component` (e.g. "api" | "worker") is a
// base field attached to every record so runtimes are distinguishable.
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

import os from "os";
import { trace, TraceFlags } from "@opentelemetry/api";
import pino from "pino";
import type { DestinationStream, Level, Logger, LoggerOptions } from "pino";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { StructuredMeta } from "@api/domain/shared/contracts";

const DEFAULT_REDACT: string[] = [
  "password",
  "*.password",
  "passwordHash",
  "*.passwordHash",
  "passwordResetTokenHash",
  "*.passwordResetTokenHash",
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "authorization",
  "*.authorization",
  "apiKey",
  "api_key",
  "*.apiKey",
  "*.api_key",
  "secret",
  "secretKey",
  "*.secret",
  "*.secretKey",
  "cardNumber",
  "*.cardNumber",
  "cvv",
  "*.cvv",
  "cookie",
  "cookies",
  "*.cookie",
  "*.cookies",
  "x-api-key",
  "x-payment-signature",
];

export interface PinoLoggerOptions {
  /** Minimum level to emit. Defaults to "info". */
  level?: Level;
  /** Base fields attached to every record. Defaults to Pino's (pid, hostname). */
  base?: LoggerOptions["base"];
  /** Redaction paths. Defaults to a conservative secret-masking list. */
  redact?: string[];
  /**
   * Render development output through a pino-pretty transport instead of raw
   * JSON. Presentation-only: records still carry the same redacted fields,
   * levels, and timestamps. Resolved centrally from LOG_PRETTY / NODE_ENV /
   * TTY in `resolveLogPretty` — never hardcoded per caller.
   */
  pretty?: boolean;
  /**
   * Runtime/component identity attached to every record (e.g. "api" or
   * "worker"). Emitted as a base field and surfaced as a `[component]` prefix
   * by the pretty transport so processes are distinguishable in dev.
   */
  component?: string;
  /**
   * Destination for log records. Defaults to Pino's stdout destination.
   * Tests inject a collector stream to assert on emitted records.
   */
  stream?: DestinationStream;
}

/**
 * Build the Pino options object for a PinoLogger. Exported so the development/
 * production configuration can be asserted without constructing a logger
 * (which would spawn a pretty transport worker thread).
 *
 * Production (pretty: false) emits plain structured JSON via Pino's default
 * (synchronous) stdout destination. Development (pretty: true) routes records
 * through a pino-pretty worker-thread transport configured for concise,
 * single-line, human-readable output: translated local timestamps, a
 * `[component]` prefix when present, and the remaining structured fields (with
 * `pid`/`hostname`/`component` hidden as noise). Redaction is applied by Pino
 * itself, before the transport, so both modes mask the same fields.
 */
export function buildPinoOptions(
  options: PinoLoggerOptions = {},
): LoggerOptions {
  const base: Record<string, unknown> = {
    pid: process.pid,
    hostname: os.hostname(),
  };
  if (options.component) {
    base.component = options.component;
  }
  Object.assign(base, options.base ?? {});

  const loggerOptions: LoggerOptions = {
    level: options.level ?? "info",
    base,
    redact: options.redact ?? DEFAULT_REDACT,
  };

  if (options.pretty) {
    loggerOptions.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        singleLine: true,
        ignore: "pid,hostname,component",
        messageFormat: "{if component}[{component}] {end}{msg}",
      },
    };
  }

  return loggerOptions;
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
  private readonly pretty: boolean;

  constructor(options: PinoLoggerOptions = {}) {
    this.pretty = options.pretty ?? false;
    this.logger = pino(buildPinoOptions(options), options.stream);
  }

  debug(message: string, meta?: StructuredMeta): void {
    const enriched = this.enrichWithTraceContext(meta);
    if (enriched) {
      this.logger.debug(this.serializeMeta(enriched), message);
    } else {
      this.logger.debug(message);
    }
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
   * Emit a bootstrap-style diagnostic report (e.g. the application startup
   * summary).
   *
   * Development (pretty): the body becomes the message itself, so the
   * pino-pretty transport prints every line literally — a genuinely readable
   * multiline startup report. Production keeps the machine-readable contract:
   * the short title becomes `msg` and the body is carried as the structured
   * `summary` field. Both modes emit the same deterministic, safe text; only
   * the presentation diverges, and only in development. Ordinary structured
   * logs (`info`/`warn`/...) are unaffected.
   */
  diagnostic(message: string, text: string): void {
    if (this.pretty) {
      this.logger.info(`${message}\n${text}`);
    } else {
      this.info(message, { summary: text });
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
