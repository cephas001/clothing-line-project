// apps/api/src/use-cases/checkout/ProcessFraudAlertEventUseCase.ts
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { IFulfillmentRepository } from "@api/domain/interfaces/repositories/IFulfillmentRepository";
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
import {
  FulfillmentRecord,
  JsonObject,
} from "@api/domain/shared/contracts";

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
 *
 * COMPENSATION (PART 11):
 * - Cancellation always addresses the PROVIDER shipment id (never the
 *   application orderId — the logistics adapter contract forbids it).
 * - If a dispatch was attempted but its provider identity is UNKNOWN (an
 *   ambiguous create or interrupted claim), the shipment is durably marked
 *   `requires_reconciliation` instead of inventing an identifier and instead of
 *   issuing a cancel against a fabricated reference. The reconciliation
 *   requirement (SHIPMENT_REQUIRES_RECONCILIATION) is surfaced to the caller.
 * - If no fulfillment record exists at all, nothing was dispatched — nothing to
 *   halt, nothing ambiguous; the fraud alert completes with an audit note.
 *
 * INVENTORY (L9):
 * - A fraud alert is a HOLD, not a cancellation: the order is flagged for
 *   manual action and fulfillment is halted, but the order is NOT cancelled and
 *   no payment/refund is created here. Inventory is therefore NEVER touched by
 *   this use case — the checked-out units were already consumed at finalization
 *   (confirmed), and if the order is later genuinely cancelled or refunded, the
 *   cancellation path (not this use case) returns stock to the available pool.
 *   Auto-restocking on a mere fraud flag would release sellable stock that may
 *   still be recovered for the order.
 */
export interface ProcessFraudAlertEventInput {
  transactionReference: string;
  actorId?: string;
}

export class ProcessFraudAlertEventUseCase {
  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly fulfillmentRepository: IFulfillmentRepository,
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

    // --- Halt physical fulfillment via logistics provider (best-effort) -------
    // PART 11: cancellation addresses the PROVIDER shipment id — never the
    // application orderId (the adapter contract rejects orderId-only cancels).
    // When the provider identity is unknown after an ambiguous create, the
    // shipment is durably marked requires_reconciliation rather than inventing
    // an identifier.
    const fulfillment = order.fulfillments.find(
      (f) => f && typeof f === "object",
    );
    const record = fulfillment
      ? (fulfillment as JsonObject)
      : null;
    const providerShipmentId = readProviderShipmentId(record);
    const trackingNumber = record
      ? readString(record, "trackingNumber")
      : null;

    try {
      if (providerShipmentId) {
        await this.logisticsService.cancelFulfillment(order.id, {
          providerShipmentId,
          trackingNumber,
        });
      } else if (record) {
        // A dispatch was attempted (a fulfillment row exists) but its provider
        // identity is unknown — an ambiguous create or an interrupted claim.
        // Do NOT invent an identifier and do NOT issue a cancel: durably mark
        // the shipment as requiring reconciliation and surface the requirement.
        this.logger.error(
          "No provider shipment reference available to halt fulfillment; marking shipment for reconciliation",
          { orderId: order.id, transactionReference },
        );
        await this.markFulfillmentRequiresReconciliation(
          record,
          order.id,
          transactionReference,
          actorId,
          nowIso,
        );
        throw new DomainError(
          "SHIPMENT_REQUIRES_RECONCILIATION",
          "The shipment cannot be identified at the provider; the order must be reconciled before fulfillment can be halted externally.",
        );
      } else {
        // No shipment was ever created for this order — nothing to halt and
        // nothing ambiguous. The fraud alert completes with an audit note.
        this.logger.info(
          "No fulfillment record to halt for fraud alert",
          { orderId: order.id, transactionReference },
        );
        try {
          await this.auditLogService.logAction(
            actorId,
            "FRAUD_ALERT_NO_SHIPMENT",
            {
              auditId: this.idGenerator.generate(),
              orderId: order.id,
              transactionReference,
              notedAt: nowIso,
            },
          );
        } catch {
          /* swallow audit errors */
        }
      }
    } catch (err: unknown) {
      if (err instanceof DomainError && err.code === "SHIPMENT_REQUIRES_RECONCILIATION") {
        // Compensation marker is durable; surface the reconciliation need.
        throw err;
      }
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

  /**
   * PART 11 — compensation when a dispatch was attempted but the provider
   * shipment id is unknown. The shipment is durably marked
   * `requires_reconciliation` (status + metadata outcome) so a reconciler can
   * resolve its identity and cancel it; an identifier is NEVER invented and a
   * cancel is NEVER issued against a fabricated reference. Best-effort: a
   * persistence failure must not mask the reconciliation requirement, which the
   * caller always surfaces.
   */
  private async markFulfillmentRequiresReconciliation(
    fulfillment: JsonObject,
    orderId: string,
    transactionReference: string,
    actorId: string,
    attemptedAt: string,
  ): Promise<void> {
    const fulfillmentId =
      readString(fulfillment, "id") ?? this.idGenerator.generate();
    const existingMeta =
      fulfillment.metadata && typeof fulfillment.metadata === "object"
        ? (fulfillment.metadata as JsonObject)
        : {};
    const marked: FulfillmentRecord = {
      ...(fulfillment as JsonObject),
      id: fulfillmentId,
      orderId: readString(fulfillment, "orderId") ?? orderId,
      trackingNumber: readString(fulfillment, "trackingNumber") ?? "",
      status: "requires_reconciliation",
      metadata: {
        dispatchAttempt: {
          ...readDispatchAttempt(existingMeta),
          outcome: "compensation_unidentified",
          compensationReason: "FRAUD_ALERT",
          compensationFailedAt: attemptedAt,
        },
      },
    };
    try {
      await this.transactionManager.execute(async () => {
        await this.fulfillmentRepository.save(marked);
      });
    } catch (persistErr: unknown) {
      this.logger.error(
        "Failed to mark fulfillment requires_reconciliation during fraud compensation",
        { err: persistErr, orderId, fulfillmentId, transactionReference },
      );
    }
    try {
      await this.auditLogService.logAction(
        actorId,
        "ORDER_DISPATCH_REQUIRES_RECONCILIATION",
        {
          auditId: this.idGenerator.generate(),
          orderId,
          fulfillmentId,
          failureCode: "COMPENSATION_UNIDENTIFIED",
          attemptedAt,
          state: "requires_reconciliation",
        },
      );
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for fraud reconciliation marker", {
        err: auditErr,
        orderId,
        fulfillmentId,
      });
    }
  }
}

/**
 * Resolve the PROVIDER shipment identity of a fulfillment record: the
 * first-class `providerShipmentId` field, falling back to the legacy
 * `metadata.logisticsResponse.providerReference`. Always the provider's id —
 * never the application orderId.
 */
function readProviderShipmentId(record: JsonObject | null): string | null {
  if (!record) {
    return null;
  }
  const direct = readString(record, "providerShipmentId");
  if (direct) {
    return direct;
  }
  const metadata = record.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const logisticsResponse = (metadata as JsonObject)["logisticsResponse"];
    if (
      logisticsResponse &&
      typeof logisticsResponse === "object" &&
      !Array.isArray(logisticsResponse)
    ) {
      return readString(logisticsResponse as JsonObject, "providerReference");
    }
  }
  return null;
}

/** Read the dispatchAttempt sub-object of a fulfillment metadata payload. */
function readDispatchAttempt(metadata: unknown): JsonObject {
  const meta =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as JsonObject)
      : {};
  const attempt = meta["dispatchAttempt"];
  return attempt && typeof attempt === "object" && !Array.isArray(attempt)
    ? (attempt as JsonObject)
    : {};
}

/** Read a trimmed non-empty string field from a JSON object. */
function readString(record: JsonObject, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
