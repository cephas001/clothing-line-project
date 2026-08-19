// apps/api/tests/fakes/FakeNotificationService.ts
//
// Configurable in-memory INotificationService for the L8-R E2E notification
// suite. Records every dispatch so tests can assert the pipeline sent exactly
// once, and injects the provider failure modes the worker must classify:
//
//   failMode | behavior
//   none     | returns the configured success result (default msg id).
//   suppress | returns `{ providerMessageId: null }` (adapter suppressed).
//   crash-before | throws BEFORE the send is recorded — models a worker crash
//             | BEFORE the provider call (the provider never received it).
//   crash-after  | RECORDS the send then throws — models a worker crash AFTER
//             | the provider accepted (at-least-once redelivery window).
//   transient    | throws `transientError` without a send (provider 5xx/timeout).
//   terminal     | throws an error carrying `terminalCategory` (a retry can
//             | never fix it: GATEWAY_AUTH / CONFIGURATION / REJECTED / ...).
//
// `sentCount` is the number of dispatches that actually reached the provider
// (a `crash-before` throw is never counted).

import type {
  INotificationService,
  NotificationDispatchResult,
  PaymentConfirmationNotification,
  ShipmentDispatchedNotification,
  TrackingUpdateNotification,
  RefundIssuedNotification,
  PasswordResetNotification,
  QuoteApprovedNotification,
  DraftOrderInvoiceNotification,
} from "@api/domain/shared/notifications";

export type FakeNotificationFailMode =
  | "none"
  | "suppress"
  | "crash-before"
  | "crash-after"
  | "transient"
  | "terminal";

export interface FakeDispatchCall {
  intentType: string;
  payload: unknown;
}

export class FakeNotificationService implements INotificationService {
  readonly calls: FakeDispatchCall[] = [];

  /** Success result returned when `failMode` is "none" (default). */
  successResult: NotificationDispatchResult = { providerMessageId: "msg_123" };

  failMode: FakeNotificationFailMode = "none";

  /** Thrown for `transient` failures (provider 5xx/timeout). */
  transientError: Error = new Error("Resend provider returned HTTP 500");

  /** `category` stamped onto the error for `terminal` failures. */
  terminalCategory = "GATEWAY_AUTH";
  terminalMessage = "Resend rejected the request with authentication failure";

  get sentCount(): number {
    return this.calls.length;
  }

  private async dispatch(
    intentType: string,
    payload: unknown,
  ): Promise<NotificationDispatchResult> {
    if (this.failMode === "crash-before") {
      // The process died before the provider was contacted: nothing recorded.
      throw this.transientError;
    }

    this.calls.push({ intentType, payload });

    if (this.failMode === "crash-after") {
      // The provider ACCEPTED the send (recorded above) but the worker died
      // before persisting the receipt.
      throw this.transientError;
    }

    if (this.failMode === "transient") {
      // Provider failure — the send was never accepted.
      throw this.transientError;
    }

    if (this.failMode === "terminal") {
      const error = new Error(this.terminalMessage) as Error & {
        category?: string;
      };
      error.category = this.terminalCategory;
      throw error;
    }

    if (this.failMode === "suppress") {
      // The adapter suppressed the send (recipient preference): no receipt.
      return { providerMessageId: null };
    }

    return this.successResult;
  }

  sendPaymentConfirmation(
    notification: PaymentConfirmationNotification,
  ): Promise<NotificationDispatchResult> {
    return this.dispatch("payment_confirmation", notification);
  }

  sendShipmentDispatched(
    notification: ShipmentDispatchedNotification,
  ): Promise<NotificationDispatchResult> {
    return this.dispatch("shipment_dispatched", notification);
  }

  sendTrackingUpdate(
    notification: TrackingUpdateNotification,
  ): Promise<NotificationDispatchResult> {
    return this.dispatch("tracking_update", notification);
  }

  sendRefundIssued(
    notification: RefundIssuedNotification,
  ): Promise<NotificationDispatchResult> {
    return this.dispatch("refund_issued", notification);
  }

  sendPasswordReset(
    notification: PasswordResetNotification,
  ): Promise<NotificationDispatchResult> {
    return this.dispatch("password_reset", notification);
  }

  sendQuoteApproved(
    notification: QuoteApprovedNotification,
  ): Promise<NotificationDispatchResult> {
    return this.dispatch("quote_approved", notification);
  }

  sendDraftOrderInvoice(
    notification: DraftOrderInvoiceNotification,
  ): Promise<NotificationDispatchResult> {
    return this.dispatch("draft_order_invoice", notification);
  }
}