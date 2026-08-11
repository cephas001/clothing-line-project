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

  // Security
  | "INVALID_SIGNATURE"

  // Resources
  | "RESOURCE_NOT_FOUND"
  | "CART_NOT_FOUND"
  | "PRODUCT_NOT_FOUND";

export class DomainError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);

    this.name = "DomainError";
    this.code = code;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
