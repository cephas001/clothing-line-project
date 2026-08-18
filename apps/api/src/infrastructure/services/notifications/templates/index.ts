// apps/api/src/infrastructure/services/notifications/templates/index.ts

// Notification template dispatcher.
//
// Maps a provider-neutral `NotificationIntent` onto a rendered email
// ({ subject, html }). The dispatcher is the ONLY template entry point the
// adapter uses; templates themselves hold no business logic and no knowledge
// of the provider. `context` carries adapter-constructed link material that a
// specific template needs (e.g. the already-built password-reset URL).

import type { NotificationIntent } from "@api/domain/shared/notifications";
import { emailShell } from "./html";
import {
  renderDraftOrderInvoice,
  renderPasswordReset,
  renderPaymentConfirmation,
  renderQuoteApproved,
  renderRefundIssued,
  renderShipmentDispatched,
  renderTrackingUpdate,
  type EmailRendering,
  type PasswordResetRenderContext,
} from "./renderers";

export interface NotificationRenderContext {
  passwordReset?: PasswordResetRenderContext;
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

export function renderNotificationEmail(
  intent: NotificationIntent,
  context?: NotificationRenderContext,
): RenderedEmail {
  let rendering: EmailRendering;
  switch (intent.type) {
    case "payment_confirmation":
      rendering = renderPaymentConfirmation(intent.payload);
      break;
    case "shipment_dispatched":
      rendering = renderShipmentDispatched(intent.payload);
      break;
    case "tracking_update":
      rendering = renderTrackingUpdate(intent.payload);
      break;
    case "refund_issued":
      rendering = renderRefundIssued(intent.payload);
      break;
    case "password_reset":
      rendering = renderPasswordReset(
        intent.payload,
        context?.passwordReset,
      );
      break;
    case "quote_approved":
      rendering = renderQuoteApproved(intent.payload);
      break;
    case "draft_order_invoice":
      rendering = renderDraftOrderInvoice(intent.payload);
      break;
  }
  return { subject: rendering.subject, html: emailShell(rendering.bodyHtml) };
}