// apps/api/src/infrastructure/composition/useCases/notifications.ts

// Factory for the notification use cases (L8). The only wired use case today
// is the outbox relay; the producing use cases (finalize order, dispatch,
// courier tracking, quote approval, draft order) migrate onto the outbox in
// later L8 parts. Each use case is constructed ONLY when all of its
// dependencies are present; missing dependencies are reported rather than
// faked.

import { EnqueuePendingNotificationsUseCase } from "@api/use-cases/notifications/EnqueuePendingNotificationsUseCase";
import type { UseCaseDependencies, UseCaseReportBuilder } from "./types";

export interface NotificationsUseCases {
  enqueuePendingNotifications: EnqueuePendingNotificationsUseCase;
}

export function buildNotificationsUseCases(
  deps: UseCaseDependencies,
  report: UseCaseReportBuilder,
): NotificationsUseCases {
  const { auditLogService, idGenerator, logger, queueService } = deps;

  const enqueuePendingNotifications = new EnqueuePendingNotificationsUseCase(
    deps.notificationOutboxRepository,
    queueService,
    auditLogService,
    idGenerator,
    logger,
  );
  report.wiredUseCases("enqueuePendingNotifications");

  return { enqueuePendingNotifications };
}