// apps/api/src/domain/errors/DomainError.ts

export type ErrorCode =
  // Validation
  | "VALIDATION_ERROR"
  | "INVALID_EMAIL"
  | "NEGATIVE_AMOUNT"
  | "INVALID_CURRENCY"

  // Business rules
  | "INVALID_OPERATION"
  | "INVALID_STATE"
  | "INVALID_STATUS_TRANSITION"
  | "OUT_OF_STOCK"
  | "REGIONAL_PRICE_MISSING"
  | "INTERNAL_ERROR"
  | "JOB_PROCESSING_ERROR"
  | "PAYMENT_VERIFICATION_FAILED"
  | "LOGISTICS_VERIFICATION_FAILED"
  /**
   * A logistics webhook event referenced a provider shipment id with NO local
   * fulfillment record. The worker must NOT fabricate a fulfillment; the event
   * is classified as operational reconciliation (retryable, but bounded by the
   * producer's attempts — never an infinite retry loop).
   */
  | "LOGISTICS_EVENT_FULFILLMENT_NOT_FOUND"
  | "EXTERNAL_SERVICE_TIMEOUT"
  | "EXTERNAL_SERVICE_UNAVAILABLE"
  | "EXTERNAL_SERVICE_ERROR"
  | "LOCK_ACQUISITION_FAILED"
  | "UNSUPPORTED_OPERATION"
  | "ORDER_ALREADY_FULFILLED"
  | "INVALID_RETURN_QUANTITY"
  | "DUPLICATE_DRAFT_ORDER"
  | "PAYMENT_REQUIRED"
  | "INVALID_RETURN_ITEM"
  | "INVALID_INPUT"
  | "REGION_NOT_FOUND"

  // Transactional
  | "DUPLICATE_TRANSACTION"
  | "TRANSACTION_NOT_FOUND"
  | "INVALID_PAYMENT_AMOUNT"
  | "PERMISSION_DENIED"
  | "DUPLICATE_QUOTE"

  // Authentication
  | "UNAUTHORIZED"
  | "UNAUTHORIZED_REVIEW"
  | "INVALID_CREDENTIALS"
  | "UNAUTHORIZED_ACCESS"
  | "CUSTOMER_ALREADY_EXISTS"
  | "COMPLIANCE_VIOLATION"
  | "ACCOUNT_DISABLED"
  | "ACCOUNT_LOCKED"
  | "BUSINESS_UNIT_ALREADY_EXISTS"

  // Payments
  | "PAYMENT_DECLINED"
  /**
   * A refund was claimed but its dispatch could not be confirmed (e.g. a crash
   * between the gateway call and the dispatch record, or a gateway rejection).
   * The outcome is ambiguous and MUST NOT be auto-retried; manual/operator
   * reconciliation is required before the refund can be re-issued.
   */
  | "REFUND_REQUIRES_REVIEW"
  /**
   * A shipment dispatch was attempted but its outcome is ambiguous (e.g. the
   * provider request timed out, or the shipment was created at the provider but
   * could not be confirmed locally). The order MUST NOT be re-dispatched
   * automatically — a fresh POST could duplicate the shipment. Manual/operator
   * reconciliation is required to confirm whether a provider shipment exists
   * and to resolve its tracking/label details.
   */
  | "SHIPMENT_REQUIRES_RECONCILIATION"

  // Security
  | "INVALID_SIGNATURE"

  // Resources
  | "RESOURCE_NOT_FOUND"
  | "CART_NOT_FOUND"
  | "PRODUCT_NOT_FOUND"

  // Inventory / sourcing (L9)
  /**
   * A single per-(variant, location) level cannot satisfy a requested
   * reservation quantity — either the level row is missing entirely or
   * available_quantity < requested quantity. The reservation was NOT consumed;
   * the caller may surface stock insufficiency or abort the checkout. Never a
   * second payment attempt.
   */
  | "INSUFFICIENT_INVENTORY"
  /**
   * Deterministic single-origin sourcing found NO active location with enough
   * available stock. The sourcing decision never splits across locations, even
   * when the caller allows split shipments.
   */
  | "INSUFFICIENT_SINGLE_LOCATION_STOCK"
  /**
   * Sourcing failed for a non-availability reason (repository/infra failure
   * while loading locations or levels). Distinct from INSUFFICIENT_* codes,
   * which are deterministic business outcomes.
   */
  | "SOURCING_FAILED";

export class DomainError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);

    this.name = "DomainError";
    this.code = code;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
