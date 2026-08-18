// apps/api/src/infrastructure/services/notifications/templates/renderers.ts

// Per-intent email renderers.
//
// Every renderer consumes the PRODUCER-NEUTRAL notification DTO (from
// domain/shared/notifications) and returns an email subject + body. Templates
// contain NO business logic: amounts are already formatted (see money.ts),
// tracking states are already normalized to `CourierTrackingState`, and any
// link is passed in as an already-built URL. Recipient names, item titles and
// notes are HTML-escaped. Internal infrastructure ids, provider credentials,
// and raw provider envelopes never appear here.

import type {
  DraftOrderInvoiceNotification,
  PaymentConfirmationNotification,
  PasswordResetNotification,
  QuoteApprovedNotification,
  RefundIssuedNotification,
  ShipmentDispatchedNotification,
  TrackingUpdateNotification,
} from "@api/domain/shared/notifications";
import { escapeHtml } from "./html";
import { formatMoneyMinor } from "./money";

export interface EmailRendering {
  subject: string;
  /** The email body HTML (wrapped by the dispatcher in the shared shell). */
  bodyHtml: string;
}

/** Greeting line from the authoritative recipient name, or a neutral fallback. */
function greet(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed
    ? `Hi ${escapeHtml(trimmed)},`
    : "Hi,";
}

export function renderPaymentConfirmation(
  n: PaymentConfirmationNotification,
): EmailRendering {
  const subject = `Payment confirmed — ${n.transactionReference}`;
  const bodyHtml = [
    `<p>${greet(n.recipient.name)}</p>`,
    "<p>Your payment was confirmed. Thank you for your order.</p>",
    "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:16px 0;border-collapse:collapse;\">",
    `<tr><td style="padding:4px 0;color:#6b7280;">Subtotal</td><td align="right">${escapeHtml(formatMoneyMinor(n.breakdown.subtotalMinor, n.order.currency))}</td></tr>`,
    `<tr><td style="padding:4px 0;color:#6b7280;">Discount</td><td align="right">−${escapeHtml(formatMoneyMinor(n.breakdown.discountMinor, n.order.currency))}</td></tr>`,
    `<tr><td style="padding:4px 0;color:#6b7280;">Tax</td><td align="right">${escapeHtml(formatMoneyMinor(n.breakdown.taxMinor, n.order.currency))}</td></tr>`,
    `<tr><td style="padding:4px 0;color:#6b7280;">Shipping</td><td align="right">${escapeHtml(formatMoneyMinor(n.breakdown.shippingMinor, n.order.currency))}</td></tr>`,
    `<tr><td style="padding:4px 0;color:#6b7280;">Insurance</td><td align="right">${escapeHtml(formatMoneyMinor(n.breakdown.insuranceMinor, n.order.currency))}</td></tr>`,
    `<tr><td style="padding:8px 0;border-top:1px solid #eeeeee;font-weight:bold;">Total</td><td align="right" style="font-weight:bold;">${escapeHtml(formatMoneyMinor(n.breakdown.totalMinor, n.order.currency))}</td></tr>`,
    "</table>",
    n.lineItems.length > 0
      ? [
          "<p style=\"margin:12px 0 4px;\"><strong>Items</strong></p>",
          "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"border-collapse:collapse;\">",
          ...n.lineItems.map(
            (line) =>
              `<tr><td style="padding:4px 0;">${escapeHtml(line.title ?? "Item")} × ${line.quantity}</td></tr>`,
          ),
          "</table>",
        ].join("\n")
      : "",
    `<p style="margin:16px 0 0;">Reference: <strong>${escapeHtml(n.transactionReference)}</strong></p>`,
    `<p style="margin:4px 0 0;color:#9ca3af;font-size:12px;">Charged ${escapeHtml(new Date(n.paidAt).toISOString())}</p>`,
  ].join("\n");
  return { subject, bodyHtml };
}

export function renderShipmentDispatched(
  n: ShipmentDispatchedNotification,
): EmailRendering {
  const subject = "Your order has been dispatched";
  const bodyHtml = [
    `<p>${greet(n.recipient.name)}</p>`,
    "<p>Great news — your order is on its way.</p>",
    `<p style="margin:12px 0 0;">Tracking number: <strong>${escapeHtml(n.trackingNumber)}</strong></p>`,
    n.courier
      ? `<p style="margin:4px 0 0;">Carrier: ${escapeHtml(n.courier)}</p>`
      : "",
    n.serviceLevel
      ? `<p style="margin:4px 0 0;">Service: ${escapeHtml(n.serviceLevel)}</p>`
      : "",
    n.labelUrl
      ? `<p style="margin:12px 0 0;"><a href="${escapeHtml(n.labelUrl)}">View your waybill label</a></p>`
      : "",
  ].join("\n");
  return { subject, bodyHtml };
}

const TRACKING_SUBJECTS: Record<TrackingUpdateNotification["status"], string> = {
  in_transit: "Your order is on the move",
  out_for_delivery: "Your order is out for delivery",
  delivered: "Your order has been delivered",
  delivery_failed: "Delivery update for your order",
};

const TRACKING_LABELS: Record<TrackingUpdateNotification["status"], string> = {
  in_transit: "in transit",
  out_for_delivery: "out for delivery",
  delivered: "delivered",
  delivery_failed: "marked as failed to deliver",
};

export function renderTrackingUpdate(
  n: TrackingUpdateNotification,
): EmailRendering {
  const subject = TRACKING_SUBJECTS[n.status];
  const bodyHtml = [
    `<p>${greet(n.recipient.name)}</p>`,
    `<p>Your package is <strong>${TRACKING_LABELS[n.status]}</strong>.</p>`,
    n.trackingNumber
      ? `<p style="margin:12px 0 0;">Tracking number: <strong>${escapeHtml(n.trackingNumber)}</strong></p>`
      : "",
    n.courier
      ? `<p style="margin:4px 0 0;">Carrier: ${escapeHtml(n.courier)}</p>`
      : "",
    n.status === "delivery_failed"
      ? "<p style=\"margin:12px 0 0;\">We are working with the carrier to resolve this. You will receive another update shortly.</p>"
      : "",
  ].join("\n");
  return { subject, bodyHtml };
}

export function renderRefundIssued(
  n: RefundIssuedNotification,
): EmailRendering {
  const subject = "Refund issued";
  const bodyHtml = [
    `<p>${greet(n.recipient.name)}</p>`,
    `<p>A refund of <strong>${escapeHtml(formatMoneyMinor(n.money.amountMinor, n.money.currency))}</strong> has been issued to your original payment method.</p>`,
    `<p style="margin:12px 0 0;">Refund reference: <strong>${escapeHtml(n.refundReference)}</strong></p>`,
    n.reason
      ? `<p style="margin:4px 0 0;">Reason: ${escapeHtml(n.reason)}</p>`
      : "",
  ].join("\n");
  return { subject, bodyHtml };
}

export interface PasswordResetRenderContext {
  /** Fully-built single-use reset URL (adapter-constructed from config). */
  resetLink?: string | null;
}

export function renderPasswordReset(
  n: PasswordResetNotification,
  context?: PasswordResetRenderContext,
): EmailRendering {
  const subject = "Reset your password";
  const minutes = Math.max(1, Math.round(n.expiresInSeconds / 60));
  const bodyHtml = [
    `<p>${greet(n.recipient.name)}</p>`,
    "<p>We received a request to reset your password. Use the button below to choose a new one.</p>",
    context?.resetLink
      ? `<p style="margin:16px 0;"><a href="${escapeHtml(context.resetLink)}" style="display:inline-block;padding:10px 18px;background:#111827;color:#ffffff;border-radius:6px;text-decoration:none;">Reset password</a></p>`
      : `<p style="margin:16px 0;">If the button is unavailable, use this single-use token: <strong>${escapeHtml(n.token)}</strong></p>`,
    `<p style="margin:12px 0 0;color:#9ca3af;font-size:12px;">This link expires in ${minutes} minute${minutes === 1 ? "" : "s"}. If you did not request this, you can safely ignore this email.</p>`,
  ].join("\n");
  return { subject, bodyHtml };
}

export function renderQuoteApproved(
  n: QuoteApprovedNotification,
): EmailRendering {
  const subject = "Your quote has been approved";
  const bodyHtml = [
    `<p>${greet(n.recipient.name)}</p>`,
    `<p>Your quote has been approved for <strong>${escapeHtml(formatMoneyMinor(n.approvedTotalMinor, n.currency))}</strong>.</p>`,
    n.note
      ? `<p style="margin:12px 0 0;">Note from the approver: ${escapeHtml(n.note)}</p>`
      : "",
  ].join("\n");
  return { subject, bodyHtml };
}

export function renderDraftOrderInvoice(
  n: DraftOrderInvoiceNotification,
): EmailRendering {
  const subject = `Invoice for your draft order — ${n.draftOrderId}`;
  const bodyHtml = [
    `<p>${greet(n.recipient.name)}</p>`,
    `<p>An invoice has been created for your draft order (${n.itemCount} item${n.itemCount === 1 ? "" : "s"}).</p>`,
    `<p style="margin:12px 0 0;">Total due: <strong>${escapeHtml(formatMoneyMinor(n.totalMinor, n.currency))}</strong></p>`,
    `<p style="margin:4px 0 0;color:#9ca3af;font-size:12px;">Draft order created ${escapeHtml(new Date(n.createdAt).toISOString())}</p>`,
  ].join("\n");
  return { subject, bodyHtml };
}