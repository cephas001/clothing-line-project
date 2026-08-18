// apps/api/src/adapters/http/middleware/body.ts

// Canonical REQUEST-BOUNDARY helpers shared by every storefront/admin HTTP
// adapter (Phase 9). Strict by default: unknown body keys are rejected, required
// fields must be present, and identifiers come only from path params / verified
// tokens — never from a request body. These helpers are pure transport
// concerns: they throw DomainError(VALIDATION_ERROR) which the canonical error
// pipeline (../errors.ts) maps to the stable HTTP envelope. No business rules
// live here.

import type { Request } from "express";
import { DomainError } from "@api/domain/entities/errors/DomainError";

/**
 * Read a required identifier from a path parameter (e.g. req.params.id).
 * A missing/blank value is a transport-level VALIDATION_ERROR; the value is
 * never validated beyond non-empty here — domain/repository rules own shape.
 */
export function readRequiredPathId(value: unknown, name: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) {
    throw new DomainError("VALIDATION_ERROR", `${name} is required.`);
  }
  return id;
}

/**
 * Parse a request body against a strict object contract (`additionalProperties:
 * false` in OpenAPI terms). Only `allowedKeys` may be present; every key in
 * `requiredKeys` must be present and non-blank. Throws VALIDATION_ERROR for an
 * unexpected field or a missing required field so a payload can never be
 * silently ignored. Returns the normalized record for the handler to read.
 */
export function parseStrictBodyObject(
  body: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = [],
): Record<string, unknown> {
  if (body === undefined || body === null) {
    throw new DomainError("VALIDATION_ERROR", "Request body is required.");
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Request body must be a JSON object.",
    );
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(allowedKeys as readonly string[]).includes(key)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Unexpected field "${key}" in request body.`,
      );
    }
  }
  for (const key of requiredKeys) {
    const value = record[key];
    if (value === undefined || value === null || value === "") {
      throw new DomainError("VALIDATION_ERROR", `${key} is required.`);
    }
  }
  return record;
}

/**
 * Reject any non-empty request body. Used by endpoints with no body contract so
 * an unexpected payload can never be ignored. `context` is used in the message
 * for observability (e.g. "shipping-quotes").
 */
export function assertEmptyRequestBody(
  body: unknown,
  context = "request",
): void {
  if (body === undefined || body === null) {
    return;
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Request body must be a JSON object.",
    );
  }
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length > 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `The ${context} request accepts no request body.`,
    );
  }
}

/** Read an optional string query parameter; blank/absent -> undefined. */
export function readQueryString(
  value: unknown,
  name: string,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new DomainError(
      "VALIDATION_ERROR",
      `${name} must be a single string value.`,
    );
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Read a REQUIRED string query parameter (throws VALIDATION_ERROR when blank). */
export function readRequiredQueryString(value: unknown, name: string): string {
  const result = readQueryString(value, name);
  if (!result) {
    throw new DomainError("VALIDATION_ERROR", `${name} is required.`);
  }
  return result;
}

/**
 * Read an optional integer query parameter, bounded to [min, max] (spec
 * minimum/maximum). Absent/blank -> defaultValue. A present non-integer or
 * out-of-range value is a VALIDATION_ERROR rather than a silent clamp.
 */
export function readQueryInt(
  value: unknown,
  name: string,
  min: number,
  max: number,
  defaultValue: number,
): number {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (typeof value !== "string") {
    throw new DomainError(
      "VALIDATION_ERROR",
      `${name} must be a single integer value.`,
    );
  }
  if (!/^-?\d+$/.test(value)) {
    throw new DomainError("VALIDATION_ERROR", `${name} must be an integer.`);
  }
  const n = Number(value);
  if (n < min || n > max) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `${name} must be between ${min} and ${max}.`,
    );
  }
  return n;
}

/** Read an optional boolean query parameter ("true"/"false"); absent -> defaultValue. */
export function readQueryBoolean(
  value: unknown,
  name: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new DomainError(
    "VALIDATION_ERROR",
    `${name} must be a boolean ("true" or "false").`,
  );
}

/**
 * Read an optional header (e.g. sales_channel_id / region_id). Absent/blank ->
 * undefined; the USE CASE decides whether a context header is required, so the
 * transport never hard-codes required-ness here.
 */
export function readOptionalHeader(req: Request, name: string): string | undefined {
  const value = (req.get(name) ?? "").trim();
  return value || undefined;
}

/** Split a comma-separated query list (e.g. expand/fields) into trimmed parts. */
export function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}
