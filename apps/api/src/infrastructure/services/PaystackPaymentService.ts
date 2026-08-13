// apps/api/src/infrastructure/services/PaystackPaymentService.ts

// Infrastructure implementation of IPaymentService backed by the Paystack
// HTTP API (https://paystack.com/docs/api). This is the ONLY module that knows
// Paystack exists. Domain/application code never imports it and never sees its
// request or response shapes; they only ever talk to the IPaymentService
// contract.
//
// Responsibilities:
// - initializeCheckoutTransaction  -> POST /transaction/initialize from the
//                                   AUTHORITATIVE durable payment obligation.
//                                   amountMinor, currency, and reference are
//                                   taken verbatim from the obligation and never
//                                   recalculated; returns the validated customer
//                                   authorization URL and the provider's
//                                   authoritative transaction reference.
// - initializeSwapPayment        -> POST /transaction/initialize from the
//                                   AUTHORITATIVE durable swap obligation.
//                                   amountMinor, currency, and reference are
//                                   taken verbatim from the obligation and never
//                                   recalculated; requires email; returns the
//                                   validated authorization URL + provider
//                                   transaction reference.
// - issueRefund                  -> POST /refund (partial refunds supported by
//                                   transmitting the amount in minor units),
//                                   returns the provider's refund reference.
// - cancelInitialization / cancelTransaction -> honest no-ops. Paystack has no
//                                   "cancel" endpoint; the application treats
//                                   these as local compensation hooks.
//
// Money: amounts are transmitted as the application's integer minor-unit
// representation (amountMinor) with NO kobo/naira conversion and NO
// floating-point arithmetic. Paystack expects minor units, so the value is
// forwarded verbatim.
//
// Error policy (matches the established infrastructure convention): failures
// surface as PaystackPaymentError, a RepositoryError subclass, so the use-case
// layer maps them onto stable DomainError codes (CONNECTION ->
// EXTERNAL_SERVICE_UNAVAILABLE, TIMEOUT -> EXTERNAL_SERVICE_TIMEOUT, UNKNOWN ->
// EXTERNAL_SERVICE_ERROR). This adapter NEVER throws DomainError and NEVER
// fabricates a "declined" classification: network timeouts, HTTP 5xx, invalid
// API credentials, malformed responses, and gateway-declared rejections are
// each classified distinctly.
//
// Security:
// - The secret key is required at construction (fail-closed; no default).
// - The secret key, the Authorization header, full request bodies, and full
//   gateway responses are NEVER logged or placed in error messages.
// - Requests are HTTPS (the base URL is enforced to be https), carry the
//   secret via "Authorization: Bearer <key>", and use a bounded timeout via
//   AbortController so a network hang can never block a request indefinitely.
// - The HTTP transport is injectable for tests; it defaults to the global
//   fetch. No HTTP client library is introduced.

import type { IPaymentService } from "@api/domain/interfaces/services/IPaymentService";
import type { CheckoutPaymentObligation } from "@api/domain/interfaces/services/IPaymentService";
import type { SwapPaymentObligation } from "@api/domain/interfaces/services/IPaymentService";
import { RepositoryErrorCode } from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { RepositoryError } from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { StructuredMeta } from "@api/domain/shared/contracts";

/** Injectable HTTP transport; defaults to the native Node fetch API. */
export type PaystackHttpClient = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** Discriminating category for a Paystack failure, preserved for observability. */
export type PaystackFailureCategory =
  | "CONFIGURATION"
  | "NETWORK"
  | "TIMEOUT"
  | "GATEWAY_AUTH"
  | "GATEWAY_REJECTED"
  | "GATEWAY_ERROR"
  | "MALFORMED_RESPONSE"
  | "MISSING_CUSTOMER_EMAIL"
  | "INVALID_PAYLOAD";

/**
 * RepositoryError subclass for Paystack failures. The `code` drives the
 * use-case mapping (CONNECTION/TIMEOUT/UNKNOWN); `category` and `cause` keep
 * the exact failure mode available to the adapter/logging without leaking
 * raw fetch/Response objects into application code.
 */
export class PaystackPaymentError extends Error implements RepositoryError {
  readonly code: RepositoryErrorCode;
  readonly category: PaystackFailureCategory;
  readonly meta?: StructuredMeta;
  readonly cause?: unknown;

  constructor(
    code: RepositoryErrorCode,
    category: PaystackFailureCategory,
    message: string,
    options: { meta?: StructuredMeta; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "PaystackPaymentError";
    this.code = code;
    this.category = category;
    this.meta = options.meta;
    this.cause = options.cause;
  }
}

export interface PaystackPaymentServiceOptions {
  /** Paystack secret key. REQUIRED — fail-closed; no default, never logged. */
  secretKey: string;
  /** Paystack API base URL. Default: https://api.paystack.co */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default: 10000. */
  timeoutMs?: number;
  /** Pino logger; the adapter logs only non-sensitive operational facts. */
  logger: ILogger;
  /** Injectable HTTP transport for tests. Defaults to the global fetch. */
  httpClient?: PaystackHttpClient;
}

const DEFAULT_PAYSTACK_BASE_URL = "https://api.paystack.co";
const DEFAULT_TIMEOUT_MS = 10_000;

const INITIALIZE_PATH = "/transaction/initialize";
const REFUND_PATH = "/refund";

interface PaystackEnvelope {
  status: boolean;
  message: string;
  data: Record<string, unknown> | null;
}

export class PaystackPaymentService implements IPaymentService {
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: ILogger;
  private readonly httpClient: PaystackHttpClient;

  constructor(options: PaystackPaymentServiceOptions) {
    if (
      typeof options.secretKey !== "string" ||
      options.secretKey.trim().length === 0
    ) {
      throw new PaystackPaymentError(
        RepositoryErrorCode.UNKNOWN,
        "CONFIGURATION",
        "PaystackPaymentService requires a non-empty secret key.",
      );
    }
    if (!options.logger) {
      throw new PaystackPaymentError(
        RepositoryErrorCode.UNKNOWN,
        "CONFIGURATION",
        "PaystackPaymentService requires a logger.",
      );
    }
    this.secretKey = options.secretKey.trim();
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_PAYSTACK_BASE_URL);
    this.timeoutMs = normalizeTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.logger = options.logger;
    this.httpClient = options.httpClient ?? ((url, init) => fetch(url, init));
  }

  // ---------------------------------------------------------------------------
  // IPaymentService
  // ---------------------------------------------------------------------------

  /**
   * Initialize a CHECKOUT payment transaction. The amount, currency, and
   * reference are read verbatim from the authoritative durable obligation —
   * this adapter NEVER independently calculates an amount, currency, or
   * reference. Every required field is validated as present (a missing or
   * malformed obligation is an INVALID_PAYLOAD failure, surfaced as
   * RepositoryErrorCode.UNKNOWN); the returned provider reference is read back
   * so callers can persist it durably.
   */
  async initializeCheckoutTransaction(
    obligation: CheckoutPaymentObligation,
  ): Promise<{ authorizationUrl: string; providerReference: string | null }> {
    if (typeof obligation !== "object" || obligation === null) {
      throw new PaystackPaymentError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "Checkout payment obligation is required.",
      );
    }

    // EXACT values from the durable obligation — never derived here.
    const email = this.requireEmail(obligation);
    const amountMinor = requireMinorAmount(obligation.amountMinor);
    const currency = requireNonEmptyString(obligation.currency, "currency");
    const reference = requireNonEmptyString(obligation.reference, "reference");

    const body = {
      email,
      amount: amountMinor,
      currency,
      reference,
      callback_url: optionalString(obligation.returnUrl),
      metadata: optionalObject(obligation.metadata),
    };

    const envelope = await this.post(INITIALIZE_PATH, body, "transaction.initialize");

    const authorizationUrl = readStringField(envelope.data, "authorization_url");
    if (!authorizationUrl) {
      throw new PaystackPaymentError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Paystack initialization response did not include an authorization_url.",
      );
    }
    const providerReference = readStringField(envelope.data, "reference");
    this.logger.info("Paystack checkout transaction initialized", {
      operation: "transaction.initialize",
    });
    return { authorizationUrl, providerReference };
  }

  /**
   * Local compensation hook invoked after a persistence failure. Paystack has
   * no endpoint to cancel an initialized transaction, so this is an honest
   * no-op that never pretends a gateway cancellation happened. Callers already
   * treat it as best-effort and swallow failures.
   */
  async cancelInitialization(
    _payload: Record<string, unknown>,
  ): Promise<void> {
    this.logger.info(
      "Paystack cancelInitialization is a no-op (no gateway cancel endpoint)",
      { operation: "transaction.cancelInitialization" },
    );
  }

  /**
   * Initialize a SWAP payment transaction. The amount, currency, and reference
   * are read verbatim from the authoritative durable obligation — this adapter
   * NEVER independently calculates an amount, currency, or reference. Every
   * required field (email, amountMinor, currency, reference) is validated as
   * present; a missing or malformed obligation is an INVALID_PAYLOAD failure
   * surfaced as RepositoryErrorCode.UNKNOWN.
   */
  async initializeSwapPayment(
    obligation: SwapPaymentObligation,
  ): Promise<{ authorizationUrl: string; providerReference: string | null }> {
    if (typeof obligation !== "object" || obligation === null) {
      throw new PaystackPaymentError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "Swap payment obligation is required.",
      );
    }

    // EXACT values from the durable obligation — never derived here.
    const email = this.requireEmail(obligation);
    const amountMinor = requireMinorAmount(obligation.amountMinor);
    const currency = requireNonEmptyString(obligation.currency, "currency");
    const reference = requireNonEmptyString(obligation.reference, "reference");

    const body = {
      email,
      amount: amountMinor,
      currency,
      reference,
      callback_url: optionalString(obligation.returnUrl),
      metadata: optionalObject(obligation.metadata),
    };

    const envelope = await this.post(INITIALIZE_PATH, body, "transaction.initialize");

    const authorizationUrl = readStringField(envelope.data, "authorization_url");
    if (!authorizationUrl) {
      throw new PaystackPaymentError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Paystack initialization response did not include an authorization_url.",
      );
    }
    const providerReference = readStringField(envelope.data, "reference");
    this.logger.info("Paystack swap payment initialized", {
      operation: "transaction.initialize",
    });
    return { authorizationUrl, providerReference };
  }

  /**
   * Issue a refund against an existing Paystack transaction, identified by the
   * application's transaction reference. `amountMinor` is transmitted in minor
   * units (integer) enabling partial refunds. The operation only resolves when
   * Paystack reports an application-level success (`status: true`); a resolved
   * fetch alone is never treated as success. Returns the provider's refund
   * reference so the application can persist dispatch durably.
   */
  async issueRefund(
    transactionReference: string,
    amountMinor: number,
    payload: Record<string, unknown>,
  ): Promise<{ providerRefundReference: string | null }> {
    const reference = (transactionReference ?? "").trim();
    if (!reference) {
      throw new PaystackPaymentError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "issueRefund requires a non-empty transaction reference.",
      );
    }
    const validatedAmount = requireMinorAmount(amountMinor);

    const body = {
      transaction: reference,
      amount: validatedAmount,
      currency: optionalString(payload.currency),
    };

    const envelope = await this.post(REFUND_PATH, body, "refund.issue");
    const providerRefundReference = readStringField(envelope.data, "reference");
    this.logger.info("Paystack refund issued", {
      operation: "refund.issue",
    });
    return { providerRefundReference };
  }

  /**
   * Local compensation hook. Paystack has no cancel/void endpoint applicable
   * here, so this is an honest no-op; the application invokes it best-effort
   * after a failed swap persistence.
   */
  async cancelTransaction(_transactionReference: string): Promise<void> {
    this.logger.info(
      "Paystack cancelTransaction is a no-op (no gateway cancel endpoint)",
      { operation: "transaction.cancel" },
    );
  }

  // ---------------------------------------------------------------------------
  // Request pipeline
  // ---------------------------------------------------------------------------

  /**
   * POST a JSON body to a Paystack path with a bounded timeout, validating the
   * HTTP status and the Paystack envelope. Every failure is normalized to a
   * PaystackPaymentError; raw fetch/Response/TypeError/JSON errors never
   * escape this method.
   */
  private async post(
    path: string,
    body: Record<string, unknown>,
    operation: string,
  ): Promise<PaystackEnvelope> {
    const url = this.baseUrl + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await this.httpClient(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (isAbortError(err)) {
        this.logger.error("Paystack request timed out", {
          operation,
          timeoutMs: this.timeoutMs,
        });
        throw new PaystackPaymentError(
          RepositoryErrorCode.TIMEOUT,
          "TIMEOUT",
          `Paystack request timed out after ${this.timeoutMs}ms.`,
          { cause: err },
        );
      }
      this.logger.error("Failed to reach Paystack", {
        operation,
        err,
      });
      throw new PaystackPaymentError(
        RepositoryErrorCode.CONNECTION,
        "NETWORK",
        "Failed to reach Paystack.",
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      const status = response.status;
      this.logger.error("Paystack request returned a non-2xx status", {
        operation,
        httpStatus: status,
        latencyMs,
      });
      if (status === 401 || status === 403) {
        throw new PaystackPaymentError(
          RepositoryErrorCode.UNKNOWN,
          "GATEWAY_AUTH",
          "Paystack rejected the API credentials.",
          { meta: { httpStatus: status } },
        );
      }
      if (status >= 500) {
        throw new PaystackPaymentError(
          RepositoryErrorCode.UNKNOWN,
          "GATEWAY_ERROR",
          `Paystack gateway error (HTTP ${status}).`,
          { meta: { httpStatus: status } },
        );
      }
      const gatewayMessage = await this.readSafeMessage(response);
      throw new PaystackPaymentError(
        RepositoryErrorCode.UNKNOWN,
        "GATEWAY_REJECTED",
        gatewayMessage ?? `Paystack rejected the request (HTTP ${status}).`,
        { meta: { httpStatus: status } },
      );
    }

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch (err: unknown) {
      this.logger.error("Paystack returned a malformed (non-JSON) response", {
        operation,
        err,
      });
      throw new PaystackPaymentError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Paystack returned a non-JSON response.",
      );
    }

    this.logger.info("Paystack request succeeded", {
      operation,
      httpStatus: response.status,
      latencyMs,
    });
    return this.validateEnvelope(envelope, operation);
  }

  /** Structural validation of the Paystack envelope; no blind casting. */
  private validateEnvelope(value: unknown, operation: string): PaystackEnvelope {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new PaystackPaymentError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Paystack response was not a JSON object.",
      );
    }
    const env = value as Record<string, unknown>;

    if (typeof env.status !== "boolean") {
      throw new PaystackPaymentError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Paystack response is missing a boolean status field.",
      );
    }

    if (env.status === false) {
      const message =
        typeof env.message === "string" && env.message.trim().length > 0
          ? env.message.trim()
          : "Paystack declined the request.";
      this.logger.warn("Paystack rejected the request", {
        operation,
        gatewayMessage: message,
      });
      throw new PaystackPaymentError(
        RepositoryErrorCode.UNKNOWN,
        "GATEWAY_REJECTED",
        message,
      );
    }

    const data =
      typeof env.data === "object" && env.data !== null && !Array.isArray(env.data)
        ? (env.data as Record<string, unknown>)
        : null;

    return {
      status: true,
      message: typeof env.message === "string" ? env.message : "",
      data,
    };
  }

  // ---------------------------------------------------------------------------
  // Payload validation helpers
  // ---------------------------------------------------------------------------

  private requireEmail(payload: { email?: unknown }): string {
    const email = optionalString(payload.email);
    if (!email) {
      throw new PaystackPaymentError(
        RepositoryErrorCode.UNKNOWN,
        "MISSING_CUSTOMER_EMAIL",
        "Paystack requires a customer email, which was not supplied in the payment payload.",
      );
    }
    return email;
  }

  /** Read a human-safe gateway message without logging the full body. */
  private async readSafeMessage(response: Response): Promise<string | null> {
    try {
      const parsed: unknown = await response.json();
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).message === "string"
      ) {
        const message = ((parsed as Record<string, unknown>).message as string).trim();
        return message.length > 0 ? message : null;
      }
    } catch {
      return null;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small validation helpers (kept module-local, no Paystack types leak out)
// ---------------------------------------------------------------------------

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(trimmed)) {
    throw new PaystackPaymentError(
      RepositoryErrorCode.UNKNOWN,
      "CONFIGURATION",
      "Paystack base URL must use HTTPS.",
    );
  }
  return trimmed;
}

function normalizeTimeout(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new PaystackPaymentError(
      RepositoryErrorCode.UNKNOWN,
      "CONFIGURATION",
      "Paystack timeout must be a positive integer of milliseconds.",
    );
  }
  return value;
}

function requireMinorAmount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PaystackPaymentError(
      RepositoryErrorCode.UNKNOWN,
      "INVALID_PAYLOAD",
      "Payment amount must be a non-negative integer in minor units.",
    );
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Require a non-empty string field. Used for the exact values that MUST come
 * from the durable obligation (currency, reference) so the adapter can never
 * silently send a missing/derived value to the gateway.
 */
function requireNonEmptyString(value: unknown, field: string): string {
  const s = optionalString(value);
  if (!s) {
    throw new PaystackPaymentError(
      RepositoryErrorCode.UNKNOWN,
      "INVALID_PAYLOAD",
      `Payment payload requires a non-empty ${field} from the durable obligation.`,
    );
  }
  return s;
}

function optionalObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
    ? (value as Record<string, unknown>)
    : null;
}

/** Read a required string field from a validated Paystack data object. */
function readStringField(
  data: Record<string, unknown> | null,
  field: string,
): string | null {
  if (!data) {
    return null;
  }
  return optionalString(data[field]);
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}
