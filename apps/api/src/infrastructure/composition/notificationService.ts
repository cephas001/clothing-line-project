// apps/api/src/infrastructure/composition/notificationService.ts

// Constructs the concrete notification adapter from configuration. This is the
// ONLY place ResendNotificationService is constructed in the application: both
// the API runtime (infrastructure/composition/bootstrap.ts) and the worker
// runtime (apps/worker/src/bootstrap.ts) source their INotificationService from
// here, so there is exactly one adapter construction policy and no duplication.
//
// Fail-closed policy (mirrors the Shipbubble adapter):
//   - No NOTIFICATION_API_KEY => undefined (notification use cases / the
//     NotificationEventWorker are REPORTED unavailable, never faked).
//   - NOTIFICATION_API_KEY present but NOTIFICATION_FROM_EMAIL absent => throw
//     (an incomplete notification configuration can never start with a
//     half-built adapter).
//
// The adapter is infrastructure-only: it never queries repositories, never
// enqueues, and never mutates business state. Recipient-preference suppression
// (NotificationPreferencePolicy) is enforced inside the adapter BEFORE any
// provider call, and returns a null receipt — the durable `dispatched` outcome
// on the outbox row, never a retry.

import { ResendNotificationService } from "../services/ResendNotificationService";
import type { INotificationService } from "@api/domain/shared/notifications";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { AppConfig } from "./config";

export function buildNotificationService(
  config: AppConfig,
  logger: ILogger,
): INotificationService | undefined {
  if (!config.notificationApiKey) {
    return undefined;
  }
  if (!config.notificationFromEmail) {
    throw new Error(
      "NOTIFICATION_API_KEY is set but NOTIFICATION_FROM_EMAIL is not; the Resend notification adapter cannot be constructed.",
    );
  }
  return new ResendNotificationService({
    apiKey: config.notificationApiKey,
    fromEmail: config.notificationFromEmail,
    fromName: config.notificationFromName,
    baseUrl: config.notificationBaseUrl,
    timeoutMs: config.notificationTimeoutMs,
    logger,
    passwordResetUrl: config.notificationPasswordResetUrl,
  });
}