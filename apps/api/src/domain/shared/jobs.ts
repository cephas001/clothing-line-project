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
 * - `QueuePaymentEventUseCase` enqueues a typed `PaymentEventJobPayload` to
 *   `payment-events-queue`. The payload is a discriminated union keyed on
 *   `obligationType`:
 *     * `checkout` (`CheckoutPaymentEventJobPayload`) — fields `cartId`,
 *       `transactionReference`, `amountPaidMinor`, `currency`,
 *       `expectedAmountMinor`, `reportedCurrency`, produced by the provider
 *       webhook mapper for a settled checkout cart obligation.
 *     * `swap` (`SwapPaymentEventJobPayload`) — fields `swapId`, `orderId`,
 *       and the same payment fields, produced for a settled swap-upcharge
 *       obligation. The raw provider envelope is never queued.
 * - `ImportBulkCatalogDataUseCase` enqueues the bulk-import metadata to
 *   `bulk-import-queue`.
 *
 * Workers MUST parse job payloads with the exported `parse*` functions instead
 * of casting arbitrary JSON: a malformed payload is a permanent failure
 * (retrying cannot fix it), so the parsers reject it with a `VALIDATION_ERROR`
 * DomainError before any use case is invoked.
 */
export type PaymentObligationType = "checkout" | "swap";

export type CheckoutPaymentEventJobPayload = {
  obligationType: "checkout";
  cartId: string;
  transactionReference: string;
  /** Amount actually captured by the provider, in integer minor units. */
  amountPaidMinor: number;
  /**
   * ISO-4217 currency code (lowercase) of the charge. Populated from the
   * DURABLE payment obligation when one resolves; null for legacy webhooks.
   * The finalizer rejects a provider currency that disagrees with the
   * obligation.
   */
  currency: string | null;
  /**
   * The authoritative amount the obligation expected (the durable payment's
   * `amountMinor`). The finalizer requires the captured amount to equal this.
   * Null for legacy webhooks without a durable obligation (best-effort only).
   */
  expectedAmountMinor: number | null;
  /**
   * ISO-4217 currency code (lowercase) AS REPORTED BY THE PROVIDER WEBHOOK
   * (`data.currency`), distinct from `currency` (the obligation's authoritative
   * currency). The worker's financial verification compares this against the
   * durable obligation; a valid signature is not sufficient. Null when the
   * webhook carried no currency (or the event predates this field).
   */
  reportedCurrency: string | null;
};

export type SwapPaymentEventJobPayload = {
  obligationType: "swap";
  /**
   * The swap obligation's identity (`payment.obligationId`), derived from local
   * authoritative state — never provider-echoed metadata. The worker verifies
   * it resolves to the correct `swap.id`.
   */
  swapId: string;
  /**
   * The order the swap modifies (`swap.orderId`), derived from the durable
   * obligation's metadata. The worker cross-checks it against the swap row.
   */
  orderId: string;
  transactionReference: string;
  amountPaidMinor: number;
  currency: string | null;
  expectedAmountMinor: number | null;
  reportedCurrency: string | null;
};

export type PaymentEventJobPayload =
  | CheckoutPaymentEventJobPayload
  | SwapPaymentEventJobPayload;

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
 * The payload is discriminated on `obligationType` ("swap" vs "checkout").
 * `obligationType` is required for new producers; a payload without it is
 * treated as a legacy checkout event (pre-discrimination producers). Extra
 * gateway fields beyond the required ones are tolerated and ignored.
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

  // `currency` is optional at the wire level: null when the webhook carried no
  // currency or no durable obligation resolved. When present it must be a
  // non-empty ISO-4217 string.
  let currency: string | null = null;
  if (value.currency !== null && value.currency !== undefined) {
    if (typeof value.currency !== "string" || value.currency.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Job payload field 'currency' must be a non-empty string or null.",
      );
    }
    currency = value.currency.trim();
  }

  // `expectedAmountMinor` is optional at the wire level: null for legacy
  // webhooks with no durable obligation. When present it must be a
  // non-negative integer.
  let expectedAmountMinor: number | null = null;
  if (
    value.expectedAmountMinor !== null &&
    value.expectedAmountMinor !== undefined
  ) {
    if (
      typeof value.expectedAmountMinor !== "number" ||
      !Number.isInteger(value.expectedAmountMinor) ||
      value.expectedAmountMinor < 0
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Job payload field 'expectedAmountMinor' must be a non-negative integer or null.",
      );
    }
    expectedAmountMinor = value.expectedAmountMinor;
  }

  // `reportedCurrency` is optional at the wire level (legacy jobs carry no such
  // field): null when the provider webhook reported no currency. When present
  // it must be a non-empty ISO-4217 string.
  let reportedCurrency: string | null = null;
  if (value.reportedCurrency !== null && value.reportedCurrency !== undefined) {
    if (
      typeof value.reportedCurrency !== "string" ||
      value.reportedCurrency.trim() === ""
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Job payload field 'reportedCurrency' must be a non-empty string or null.",
      );
    }
    reportedCurrency = value.reportedCurrency.trim();
  }

  // Discriminate on obligationType. A payload without it is a legacy checkout
  // event (pre-discrimination producers emitted only checkout payloads).
  if (value.obligationType === "swap") {
    const swapId = requiredString(value.swapId, "swapId");
    const orderId = requiredString(value.orderId, "orderId");
    return {
      obligationType: "swap",
      swapId,
      orderId,
      transactionReference,
      amountPaidMinor,
      currency,
      expectedAmountMinor,
      reportedCurrency,
    };
  }

  const cartId = requiredString(value.cartId, "cartId");
  return {
    obligationType: "checkout",
    cartId,
    transactionReference,
    amountPaidMinor,
    currency,
    expectedAmountMinor,
    reportedCurrency,
  };
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
