// apps/api/src/infrastructure/services/notifications/NotificationPreference.ts

// Notification-recipient preference policy (L8 PART 17).
//
// Policy: transactional and legal notifications are MANDATORY — a recipient's
// opt-out or unsubscribe may never suppress a payment confirmation, a shipment
// dispatch, a tracking update, a refund, a password reset, a B2B quote
// approval, or a draft-order invoice. There are no marketing intents in the
// application today, so the default policy never suppresses anything.
//
// The policy interface is injectable so a future marketing intent can plug in
// a preference store WITHOUT touching the domain or the adapter.

import type { NotificationIntent } from "@api/domain/shared/notifications";

export type NotificationCategory = "transactional" | "marketing";

/**
 * Classify an intent. Today every intent is transactional/legal; this is the
 * single place a future marketing intent gets classified.
 */
export function classifyNotification(intent: NotificationIntent): NotificationCategory {
  switch (intent.type) {
    case "payment_confirmation":
    case "shipment_dispatched":
    case "tracking_update":
    case "refund_issued":
    case "password_reset":
    case "quote_approved":
    case "draft_order_invoice":
      return "transactional";
  }
}

/**
 * Inject able suppression decision for a recipient + intent.
 * Implementations must return true ONLY when the intent may be legally
 * skipped (i.e. marketing). Transactional/legal intents are never suppressed.
 */
export interface NotificationPreferencePolicy {
  isSuppressed(
    recipientEmail: string,
    intent: NotificationIntent,
  ): Promise<boolean>;
}

/**
 * Default policy: marketing intents are suppressible (none exist today →
 * nothing is ever suppressed), transactional/legal intents are always sent.
 */
export class DefaultNotificationPreferencePolicy
  implements NotificationPreferencePolicy
{
  async isSuppressed(
    _recipientEmail: string,
    intent: NotificationIntent,
  ): Promise<boolean> {
    return classifyNotification(intent) === "marketing";
  }
}