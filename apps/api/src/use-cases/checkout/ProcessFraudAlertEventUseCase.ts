// apps/api/src/use-cases/checkout/ProcessFraudAlertEventUseCase.ts
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { ILogisticsService } from "@api/domain/interfaces/services/ILogisticsService";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import { Order } from "@api/domain/entities/Order";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";

/**
 * Use case: process an incoming fraud alert for a payment/transaction.
 *
 * Responsibilities:
 * - Validate input (transactionReference).
 * - Load the order associated with the transaction reference; short-circuit if not found.
 * - Transition order payment state to require manual action and persist changes.
 * - Halt physical fulfillment immediately by calling the logistics provider.
 * - Map repository and external service errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the fraud alert processing and outcome.
 * - Log structured events and failures for observability.
 */
export interface ProcessFraudAlertEventInput {
  transactionReference: string;
  actorId?: string;
}

export class ProcessFraudAlertEventUseCase {
  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly logisticsService: ILogisticsService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(input: ProcessFraudAlertEventInput): Promise<void> {
    const transactionReference = (input.transactionReference ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";

    // --- Validate input
    if (!transactionReference) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "transactionReference is required.",
      );
    }

    // --- Load order by transaction reference
    let order: Order | null;
    try {
      order = await this.orderRepository.findByTransactionReference(
        transactionReference,
      );
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to load order by transaction reference", {
        err,
        transactionReference,
      });
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while loading order.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while loading order.",
        );
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to load order for fraud alert processing.",
      );
    }

    // If no order found, nothing to do (idempotent)
    if (!order) {
      this.logger.info(
        "No order found for transaction reference; skipping fraud alert processing",
        { transactionReference },
      );
      try {
        await this.auditLogService.logAction(actorId, "FRAUD_ALERT_NO_ORDER", {
          auditId: this.idGenerator.generate(),
          transactionReference,
          notedAt: new Date().toISOString(),
        });
      } catch {
        /* swallow audit errors */
      }
      return;
    }

    // --- If order already in a state that requires action, treat as idempotent
    const currentPaymentStatus = order.paymentStatus;
    if (
      currentPaymentStatus === "requires_action" ||
      currentPaymentStatus === "on_hold"
    ) {
      this.logger.info(
        "Order already marked as requiring action; idempotent handling",
        { orderId: order.id, transactionReference },
      );
      try {
        await this.auditLogService.logAction(
          actorId,
          "FRAUD_ALERT_IDEMPOTENT",
          {
            auditId: this.idGenerator.generate(),
            orderId: order.id,
            transactionReference,
            notedAt: new Date().toISOString(),
          },
        );
      } catch {
        /* swallow audit errors */
      }
      return;
    }

    // --- Transition order payment status and persist inside a transactional unit of work
    const nowIso = new Date().toISOString();
    try {
      const persist = async () => {
        order.setPaymentStatus("requires_action", {
          reason: "FRAUD_ALERT",
          updatedAt: nowIso,
        });

        // Mark fulfillment as halted on the order domain
        order.haltFulfillment({ reason: "FRAUD_ALERT", haltedAt: nowIso });

        await this.orderRepository.save(order);
      };

      await this.transactionManager.execute(persist);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error(
        "Failed to persist order state change for fraud alert",
        { err, orderId: order.id, transactionReference },
      );

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while updating order.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while updating order.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        // Defensive: concurrent modification detected
        throw new DomainError(
          "INVALID_OPERATION",
          "Concurrent modification detected while updating order.",
        );
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to update order for fraud alert.",
      );
    }

    // --- Halt physical fulfillment via logistics provider (best-effort)
    try {
      const trackingRaw = order.fulfillments.find(
        (f) => f && typeof f === "object",
      )?.["trackingNumber"];
      const trackingNumber =
        typeof trackingRaw === "string" || typeof trackingRaw === "number"
          ? trackingRaw
          : "";
      await this.logisticsService.cancelFulfillment(order.id, {
        trackingNumber,
      });
    } catch (err: unknown) {
      // Map logistics adapter errors conservatively but do not revert order state
      this.logger.error(
        "Failed to cancel fulfillment with logistics provider",
        { err, orderId: order.id },
      );
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        // External provider unavailable — surface as external service issue
        throw new DomainError(
          "EXTERNAL_SERVICE_UNAVAILABLE",
          "Failed to contact logistics provider to halt fulfillment.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "EXTERNAL_SERVICE_TIMEOUT",
          "Logistics provider timed out while attempting to halt fulfillment.",
        );
      }

      // Generic fallback: log and continue, but surface an internal error so caller can react
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to halt fulfillment for flagged order.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "FRAUD_ALERT_PROCESSED", {
        auditId: this.idGenerator.generate(),
        orderId: order.id,
        transactionReference,
        newPaymentStatus: "requires_action",
        fulfillmentStatus: order.fulfillmentStatus ?? "on_hold",
        processedAt: nowIso,
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for fraud alert processing", {
        err: auditErr,
        orderId: order.id,
        transactionReference,
      });
    }

    this.logger.info("Fraud alert processed and fulfillment halted", {
      orderId: order.id,
      transactionReference,
    });
    return;
  }
}
