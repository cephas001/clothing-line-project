// apps/api/src/use-cases/logistics/ConfirmOrderEditUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IOrderEditRepository } from "@api/domain/interfaces/repositories/IOrderEditRepository";
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { Order } from "@api/domain/entities/Order";
import { OrderEdit } from "@api/domain/entities/OrderEdit";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface ConfirmOrderEditInput {
  orderEditId: string;
  paymentConfirmed: boolean;
  actorId?: string;
  paymentReference?: string | null;
}

export class ConfirmOrderEditUseCase {
  constructor(
    private readonly orderEditRepository: IOrderEditRepository,
    private readonly orderRepository: IOrderRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  /**
   * Confirm a previously proposed order edit.
   * - Validates the edit and payment state.
   * - Applies the proposed changes to the live order entity.
   * - Persists both order and orderEdit transactionally.
   * - Emits audit logs and structured logs.
   */
  async execute(
    input: ConfirmOrderEditInput,
  ): Promise<{ orderId: string; orderEditId: string; status: string }> {
    const orderEditId = (input.orderEditId ?? "").trim();
    const paymentConfirmed = Boolean(input.paymentConfirmed);
    const actorId = (input.actorId ?? "system").trim() || "system";
    const paymentReference = input.paymentReference ?? null;

    if (!orderEditId) {
      throw new DomainError("VALIDATION_ERROR", "orderEditId is required.");
    }

    const auditId = this.idGenerator.generate();
    const startedAt = new Date().toISOString();
    this.logger.info("Confirming order edit started", {
      orderEditId,
      paymentConfirmed,
      actorId,
      auditId,
    });

    // --- Load order edit
    let orderEdit: OrderEdit | null;
    try {
      orderEdit = await this.orderEditRepository.findById(orderEditId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to load order edit", {
        err,
        orderEditId,
        auditId,
      });

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while loading order edit.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while loading order edit.",
        );
      }

      throw new DomainError("INTERNAL_ERROR", "Failed to load order edit.");
    }

    if (!orderEdit) {
      this.logger.info("Order edit not found", { orderEditId, auditId });
      throw new DomainError(
        "RESOURCE_NOT_FOUND",
        "Order edit proposal not found.",
      );
    }

    // --- Idempotency: already confirmed or applied
    if (orderEdit.status === "confirmed" || orderEdit.status === "applied") {
      this.logger.info("Order edit already confirmed or applied", {
        orderEditId,
        currentStatus: orderEdit.status,
        auditId,
      });
      try {
        await this.auditLogService.logAction(
          actorId,
          "ORDER_EDIT_CONFIRM_SKIPPED_ALREADY_APPLIED",
          {
            auditId,
            orderEditId,
            currentStatus: orderEdit.status,
            notedAt: startedAt,
          },
        );
      } catch {
        /* swallow audit errors */
      }
      return {
        orderId: orderEdit.orderId,
        orderEditId,
        status: orderEdit.status,
      };
    }

    // --- Payment guard
    if (Number(orderEdit.differenceDueMinor ?? 0) > 0 && !paymentConfirmed) {
      this.logger.info("Payment required but not confirmed for order edit", {
        orderEditId,
        differenceDueMinor: orderEdit.differenceDueMinor,
        auditId,
      });
      throw new DomainError(
        "PAYMENT_REQUIRED",
        "Outstanding balance must be settled before confirming the edit.",
      );
    }

    // --- Load base order
    let order: Order | null;
    try {
      order = await this.orderRepository.findById(orderEdit.orderId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to load base order for edit confirmation", {
        err,
        orderEditId,
        orderId: orderEdit.orderId,
        auditId,
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

      throw new DomainError("INTERNAL_ERROR", "Failed to load base order.");
    }

    if (!order) {
      this.logger.info("Base order not found for edit confirmation", {
        orderEditId,
        orderId: orderEdit.orderId,
        auditId,
      });
      throw new DomainError("RESOURCE_NOT_FOUND", "Base order not found.");
    }

    // --- Apply edits to order entity
    try {
      order.applyConfirmedEdits(orderEdit.proposedChanges, {
        appliedBy: actorId,
        appliedAt: startedAt,
      });
    } catch (err: unknown) {
      this.logger.error("Failed to apply confirmed edits to order entity", {
        err,
        orderEditId,
        orderId: order.id,
        auditId,
      });
      throw new DomainError("INTERNAL_ERROR", "Failed to apply order edits.");
    }

    // --- Persist order and orderEdit transactionally
    try {
      const work = async () => {
        // Update orderEdit metadata
        orderEdit.confirm({ confirmedAt: startedAt, confirmedBy: actorId });
        if (paymentReference) orderEdit.paymentReference = paymentReference;

        await this.orderRepository.save(order);
        await this.orderEditRepository.save(orderEdit);

        // Mark orderEdit as applied
        orderEdit.markAsApplied({ appliedAt: startedAt, appliedBy: actorId });
        await this.orderEditRepository.save(orderEdit);
      };

      await this.transactionManager.execute(work);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error(
        "Failed to persist confirmed order edit or update order",
        { err, orderEditId, orderId: order.id, auditId },
      );

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "INVALID_OPERATION",
          "Concurrent modification detected while confirming order edit.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving order edit confirmation.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving order edit confirmation.",
        );
      }

      // No further compensation attempted here; surface generic error
      throw new DomainError("INTERNAL_ERROR", "Failed to confirm order edit.");
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "ORDER_EDIT_CONFIRMED", {
        auditId,
        orderEditId,
        orderId: order.id,
        confirmedBy: actorId,
        confirmedAt: startedAt,
        differenceDueMinor: String(orderEdit.differenceDueMinor ?? 0),
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for order edit confirmation", {
        err: auditErr,
        orderEditId,
        orderId: order.id,
      });
    }

    this.logger.info("Order edit confirmed and applied", {
      orderEditId,
      orderId: order.id,
      actorId,
      auditId,
    });
    return { orderId: order.id, orderEditId, status: orderEdit.status };
  }
}
