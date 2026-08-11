// apps/api/src/domain/shared/jobs.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";

/**
 * Authoritative queue names for the background-job queues this application
 * publishes to and consumes from. Every producer, consumer, and worker must
 * reference these constants instead of embedding literal queue names, so the
 * contract lives in exactly one shared application location.
 */
export const QUEUE_NAMES = {
  paymentEvents: "payment-events-queue",
  bulkCatalogImport: "bulk-import-queue",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Typed job payload contracts for the background-job queues this application
 * publishes to and consumes from.
 *
 * These contracts mirror what the producers actually enqueue:
 * - `QueuePaymentEventUseCase` enqueues the gateway `parsedPayload` to
 *   `payment-events-queue`; its required fields match the
 *   `WebhookPaymentFinalizeRequest` schema.
 * - `ImportBulkCatalogDataUseCase` enqueues the bulk-import metadata to
 *   `bulk-import-queue`.
 *
 * Workers MUST parse job payloads with the exported `parse*` functions instead
 * of casting arbitrary JSON: a malformed payload is a permanent failure
 * (retrying cannot fix it), so the parsers reject it with a `VALIDATION_ERROR`
 * DomainError before any use case is invoked.
 */
export interface PaymentEventJobPayload {
  cartId: string;
  transactionReference: string;
  amountPaidMinor: number;
}

export interface BulkCatalogImportJobPayload {
  jobId: string;
  adminUserId: string;
  fileUrl: string;
  fileType: "csv" | "json" | null;
  enqueuedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Job payload field '${field}' is required and must be a non-empty string.`,
    );
  }
  return value.trim();
}

/**
 * Validate an opaque job payload against the `PaymentEventJobPayload` contract.
 * Extra gateway fields beyond the required ones are tolerated and ignored.
 */
export function parsePaymentEventJobPayload(
  value: unknown,
): PaymentEventJobPayload {
  if (!isRecord(value)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Payment event job payload must be an object.",
    );
  }

  const cartId = requiredString(value.cartId, "cartId");
  const transactionReference = requiredString(
    value.transactionReference,
    "transactionReference",
  );
  const amountPaidMinor = value.amountPaidMinor;

  if (
    typeof amountPaidMinor !== "number" ||
    !Number.isInteger(amountPaidMinor) ||
    amountPaidMinor < 0
  ) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Job payload field 'amountPaidMinor' must be a non-negative integer.",
    );
  }

  return { cartId, transactionReference, amountPaidMinor };
}

/**
 * Validate an opaque job payload against the `BulkCatalogImportJobPayload`
 * contract.
 */
export function parseBulkCatalogImportJobPayload(
  value: unknown,
): BulkCatalogImportJobPayload {
  if (!isRecord(value)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Bulk catalog import job payload must be an object.",
    );
  }

  const jobId = requiredString(value.jobId, "jobId");
  const adminUserId = requiredString(value.adminUserId, "adminUserId");
  const fileUrl = requiredString(value.fileUrl, "fileUrl");
  const fileType = value.fileType;
  const enqueuedAt = requiredString(value.enqueuedAt, "enqueuedAt");

  if (fileType !== null && fileType !== "csv" && fileType !== "json") {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Job payload field 'fileType' must be 'csv', 'json', or null.",
    );
  }

  if (Number.isNaN(Date.parse(enqueuedAt))) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Job payload field 'enqueuedAt' must be a valid date string.",
    );
  }

  return { jobId, adminUserId, fileUrl, fileType, enqueuedAt };
}
