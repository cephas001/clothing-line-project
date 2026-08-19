// apps/api/src/infrastructure/services/ResendNotificationService.ts

// Infrastructure implementation of INotificationService backed by the Resend
// HTTP API (https://resend.com/docs/api-reference/emails/send-email). This is
// the ONLY module that knows Resend exists. Domain/application code never
// imports it and never sees its request/response shapes; they only ever talk
// to the provider-neutral INotificationService contract
// (domain/shared/notifications).
//
// Responsibilities:
// - Map each business INTENT (payment confirmed, shipment dispatched, tracking
//   update, refund issued, password reset, quote approved, draft-order
//   invoice) onto a rendered email + a POST /emails call. The intent payloads
//   are already the provider-neutral DTOs the use cases build from frozen
//   authoritative state; this adapter adds no financial or routing logic.
// - Render email HTML via the template layer
//   (infrastructure/services/notifications/templates) — never inline.
// - Enforce recipient preferences via the injectable NotificationPreferencePolicy
//   (default: transactional/legal notifications are never suppressed).
// - Audit AFTER the provider call resolves: log only SAFE metadata
//   (intentType, outcome, httpStatus, latencyMs, providerMessageId) — never
//   the email body, subject, recipient, or API key.
//
// Money: monetary values are only ever formatted for display by the template
// layer (formatMoneyMinor) with integer minor-unit math; the adapter itself
// does no money arithmetic.
//
// Error policy (matches the established infrastructure convention): failures
// surface as ResendNotificationError, a RepositoryError subclass, so the
// use-case layer maps them onto stable DomainError codes (CONNECTION ->
// EXTERNAL_SERVICE_UNAVAILABLE, TIMEOUT -> EXTERNAL_SERVICE_TIMEOUT, UNKNOWN ->
// EXTERNAL_SERVICE_ERROR). The adapter NEVER throws DomainError.
//
// Security (L8 PART 16/20/21):
// - The API key and from-email are required at construction (fail-closed; no
//   defaults). The key is never logged.
// - The API key, Authorization header, email bodies, subjects, recipients, and
//   full provider responses are NEVER logged or placed in error messages.
// - Requests are HTTPS (enforced), carry the key via "Authorization: Bearer
//   <key>", and use a bounded timeout via AbortController.
// - The HTTP transport is injectable for tests; it defaults to the global
//   fetch. No HTTP client library is introduced.

import type {
  INotificationService,
  NotificationDispatchResult,
  NotificationIntent,
  PaymentConfirmationNotification,
  ShipmentDispatchedNotification,
  TrackingUpdateNotification,
  RefundIssuedNotification,
  PasswordResetNotification,
  QuoteApprovedNotification,
  DraftOrderInvoiceNotification,
} from "@api/domain/shared/notifications";
import { RepositoryErrorCode } from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { RepositoryError } from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { StructuredMeta } from "@api/domain/shared/contracts";
import {
  DefaultNotificationPreferencePolicy,
  type NotificationPreferencePolicy,
} from "./notifications/NotificationPreference";
import {
  renderNotificationEmail,
  type NotificationRenderContext,
} from "./notifications/templates";

/** Injectable HTTP transport; defaults to the native Node fetch API. */
export type ResendHttpClient = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** Discriminating category for a Resend failure, preserved for observability. */
export type ResendFailureCategory =
  | "CONFIGURATION"
  | "NETWORK"
  | "TIMEOUT"
  | "GATEWAY_AUTH"
  | "GATEWAY_REJECTED"
  | "GATEWAY_ERROR"
  | "MALFORMED_RESPONSE"
  | "INVALID_PAYLOAD";

/**
 * RepositoryError subclass for Resend failures. The `code` drives the
 * use-case mapping (CONNECTION/TIMEOUT/UNKNOWN); `category` and `cause` keep
 * the exact failure mode available to the adapter/logging without leaking
 * raw fetch/Response objects into application code.
 */
export class ResendNotificationError extends Error implements RepositoryError {
  readonly code: RepositoryErrorCode;
  readonly category: ResendFailureCategory;
  readonly meta?: StructuredMeta;
  readonly cause?: unknown;

  constructor(
    code: RepositoryErrorCode,
    category: ResendFailureCategory,
    message: string,
    options: { meta?: StructuredMeta; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ResendNotificationError";
    this.code = code;
    this.category = category;
    this.meta = options.meta;
    this.cause = options.cause;
  }
}

export interface ResendNotificationServiceOptions {
  /** Resend API key. REQUIRED — fail-closed; no default, never logged. */
  apiKey: string;
  /** Authoritative sender address. REQUIRED — fail-closed; no default. */
  fromEmail: string;
  /** Optional sender display name, e.g. "Clothing Line". */
  fromName?: string | null;
  /** Resend API base URL. Default: https://api.resend.com */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default: 10000. */
  timeoutMs?: number;
  /** Pino logger; the adapter logs only non-sensitive operational facts. */
  logger: ILogger;
  /** Injectable HTTP transport for tests. Defaults to the global fetch. */
  httpClient?: ResendHttpClient;
  /** Recipient preference policy. Defaults to never-suppress transactional. */
  preferences?: NotificationPreferencePolicy;
  /**
   * Base URL used to build the single-use password-reset link (e.g.
   * "https://shop.example.com/reset-password?token="). When absent, the
   * password-reset email renders the raw token instead of a link.
   */
  passwordResetUrl?: string | null;
}

const DEFAULT_RESEND_BASE_URL = "https://api.resend.com";
const DEFAULT_TIMEOUT_MS = 10_000;

const SEND_EMAIL_PATH = "/emails";

interface ResendEnvelope {
  id?: string | null;
}

export class ResendNotificationService implements INotificationService {
  private readonly apiKey: string;
  private readonly fromEmail: string;
  private readonly fromName: string | null;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: ILogger;
  private readonly httpClient: ResendHttpClient;
  private readonly preferences: NotificationPreferencePolicy;
  private readonly passwordResetUrl: string | null;

  constructor(options: ResendNotificationServiceOptions) {
    if (
      typeof options.apiKey !== "string" ||
      options.apiKey.trim().length === 0
    ) {
      throw new ResendNotificationError(
        RepositoryErrorCode.UNKNOWN,
        "CONFIGURATION",
        "ResendNotificationService requires a non-empty API key.",
      );
    }
    if (
      typeof options.fromEmail !== "string" ||
      options.fromEmail.trim().length === 0
    ) {
      throw new ResendNotificationError(
        RepositoryErrorCode.UNKNOWN,
        "CONFIGURATION",
        "ResendNotificationService requires a non-empty from email.",
      );
    }
    if (!options.logger) {
      throw new ResendNotificationError(
        RepositoryErrorCode.UNKNOWN,
        "CONFIGURATION",
        "ResendNotificationService requires a logger.",
      );
    }
    this.apiKey = options.apiKey.trim();
    this.fromEmail = options.fromEmail.trim();
    this.fromName =
      typeof options.fromName === "string" && options.fromName.trim().length > 0
        ? options.fromName.trim()
        : null;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_RESEND_BASE_URL);
    this.timeoutMs = normalizeTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.logger = options.logger;
    this.httpClient = options.httpClient ?? ((url, init) => fetch(url, init));
    this.preferences = options.preferences ?? new DefaultNotificationPreferencePolicy();
    this.passwordResetUrl =
      typeof options.passwordResetUrl === "string" &&
      options.passwordResetUrl.trim().length > 0
        ? options.passwordResetUrl.trim()
        : null;
  }

  // ---------------------------------------------------------------------------
  // INotificationService — each intent maps onto dispatch(). No channel logic
  // here: the intent DTO carries the recipient (from authoritative state), the
  // template layer renders, and dispatch() performs the single provider call.
  // ---------------------------------------------------------------------------

  async sendPaymentConfirmation(
    notification: PaymentConfirmationNotification,
  ): Promise<NotificationDispatchResult> {
    return this.dispatch({
      type: "payment_confirmation",
      payload: notification,
    });
  }

  async sendShipmentDispatched(
    notification: ShipmentDispatchedNotification,
  ): Promise<NotificationDispatchResult> {
    return this.dispatch({
      type: "shipment_dispatched",
      payload: notification,
    });
  }

  async sendTrackingUpdate(
    notification: TrackingUpdateNotification,
  ): Promise<NotificationDispatchResult> {
    return this.dispatch({
      type: "tracking_update",
      payload: notification,
    });
  }

  async sendRefundIssued(
    notification: RefundIssuedNotification,
  ): Promise<NotificationDispatchResult> {
    return this.dispatch({
      type: "refund_issued",
      payload: notification,
    });
  }

  async sendPasswordReset(
    notification: PasswordResetNotification,
  ): Promise<NotificationDispatchResult> {
    return this.dispatch({
      type: "password_reset",
      payload: notification,
    });
  }

  async sendQuoteApproved(
    notification: QuoteApprovedNotification,
  ): Promise<NotificationDispatchResult> {
    return this.dispatch({
      type: "quote_approved",
      payload: notification,
    });
  }

  async sendDraftOrderInvoice(
    notification: DraftOrderInvoiceNotification,
  ): Promise<NotificationDispatchResult> {
    return this.dispatch({
      type: "draft_order_invoice",
      payload: notification,
    });
  }

  // ---------------------------------------------------------------------------
  // Dispatch pipeline
  // ---------------------------------------------------------------------------

  /**
   * Preference gate → render → single POST /emails → audit. The provider call
   * is made only AFTER the caller committed authoritative state (use cases
   * enforce this); a failure here is surfaced to the caller, which treats
   * delivery as best-effort. The returned receipt carries the provider-assigned
   * message id the notification worker persists on the outbox row.
   */
  private async dispatch(
    intent: NotificationIntent,
  ): Promise<NotificationDispatchResult> {
    const intentType = intent.type;
    const recipientEmail = intent.payload.recipient.email;

    if (await this.preferences.isSuppressed(recipientEmail, intent)) {
      this.logger.warn("Notification suppressed by recipient preference", {
        intentType,
      });
      return { providerMessageId: null };
    }

    let rendered: { subject: string; html: string };
    try {
      rendered = renderNotificationEmail(
        intent,
        this.renderContext(intent),
      );
    } catch (err: unknown) {
      this.logger.error("Notification template rendering failed", {
        intentType,
        err,
      });
      throw new ResendNotificationError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "Notification could not be rendered.",
        { cause: err },
      );
    }

    const from = this.fromName
      ? `${this.fromName} <${this.fromEmail}>`
      : this.fromEmail;

    const envelope = await this.post(
      SEND_EMAIL_PATH,
      {
        from,
        to: [recipientEmail],
        subject: rendered.subject,
        html: rendered.html,
      },
      intentType,
    );

    const providerMessageId = envelope.id ?? null;
    // SAFE AUDIT ONLY — outcome + latency; never body/subject/recipient.
    this.logger.info("Notification email sent", {
      intentType,
      outcome: "sent",
      providerMessageId,
    });
    return { providerMessageId };
  }

  /** Build adapter-configured template context (e.g. the reset link). */
  private renderContext(intent: NotificationIntent): NotificationRenderContext {
    if (intent.type !== "password_reset" || !this.passwordResetUrl) {
      return {};
    }
    return {
      passwordReset: {
        resetLink: this.passwordResetUrl + encodeURIComponent(intent.payload.token),
      },
    };
  }

  /**
   * POST a JSON body to a Resend path with a bounded timeout, validating the
   * HTTP status and the Resend envelope. Every failure is normalized to a
   * ResendNotificationError; raw fetch/Response/TypeError/JSON errors never
   * escape this method.
   */
  private async post(
    path: string,
    body: Record<string, unknown>,
    intentType: string,
  ): Promise<ResendEnvelope> {
    const url = this.baseUrl + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await this.httpClient(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (isAbortError(err)) {
        this.logger.error("Resend request timed out", {
          intentType,
          timeoutMs: this.timeoutMs,
        });
        throw new ResendNotificationError(
          RepositoryErrorCode.TIMEOUT,
          "TIMEOUT",
          `Resend request timed out after ${this.timeoutMs}ms.`,
          { cause: err },
        );
      }
      this.logger.error("Failed to reach Resend", {
        intentType,
        err,
      });
      throw new ResendNotificationError(
        RepositoryErrorCode.CONNECTION,
        "NETWORK",
        "Failed to reach Resend.",
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      const status = response.status;
      this.logger.error("Resend request returned a non-2xx status", {
        intentType,
        outcome: "failed",
        httpStatus: status,
        latencyMs,
      });
      if (status === 401 || status === 403) {
        throw new ResendNotificationError(
          RepositoryErrorCode.UNKNOWN,
          "GATEWAY_AUTH",
          "Resend rejected the API credentials.",
          { meta: { httpStatus: status } },
        );
      }
      if (status >= 500) {
        throw new ResendNotificationError(
          RepositoryErrorCode.UNKNOWN,
          "GATEWAY_ERROR",
          `Resend gateway error (HTTP ${status}).`,
          { meta: { httpStatus: status } },
        );
      }
      const gatewayMessage = await this.readSafeMessage(response);
      throw new ResendNotificationError(
        RepositoryErrorCode.UNKNOWN,
        "GATEWAY_REJECTED",
        gatewayMessage ?? `Resend rejected the request (HTTP ${status}).`,
        { meta: { httpStatus: status } },
      );
    }

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch (err: unknown) {
      this.logger.error("Resend returned a malformed (non-JSON) response", {
        intentType,
        err,
      });
      throw new ResendNotificationError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Resend returned a non-JSON response.",
      );
    }

    this.logger.info("Resend request succeeded", {
      intentType,
      outcome: "accepted",
      httpStatus: response.status,
      latencyMs,
    });
    return this.validateEnvelope(envelope, intentType);
  }

  /** Structural validation of the Resend envelope; no blind casting. */
  private validateEnvelope(value: unknown, intentType: string): ResendEnvelope {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ResendNotificationError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Resend response was not a JSON object.",
      );
    }
    const env = value as Record<string, unknown>;
    const id =
      typeof env.id === "string" && env.id.trim().length > 0
        ? env.id.trim()
        : null;
    if (!id) {
      this.logger.error("Resend response did not include a message id", {
        intentType,
      });
      throw new ResendNotificationError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Resend response did not include a message id.",
      );
    }
    return { id };
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
// Small validation helpers (kept module-local, no Resend types leak out)
// ---------------------------------------------------------------------------

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(trimmed)) {
    throw new ResendNotificationError(
      RepositoryErrorCode.UNKNOWN,
      "CONFIGURATION",
      "Resend base URL must use HTTPS.",
    );
  }
  return trimmed;
}

function normalizeTimeout(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ResendNotificationError(
      RepositoryErrorCode.UNKNOWN,
      "CONFIGURATION",
      "Resend timeout must be a positive integer of milliseconds.",
    );
  }
  return value;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}