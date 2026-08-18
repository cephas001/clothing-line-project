// apps/api/src/use-cases/logistics/ProposeOrderEditUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { IOrderEditRepository } from "@api/domain/interfaces/repositories/IOrderEditRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { Order } from "@api/domain/entities/Order";
import { OrderEdit } from "@api/domain/entities/OrderEdit";
import {
  toPositiveQuantity,
  toSignedSafeInteger,
} from "@api/utils/moneyUtils";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface ProposeOrderEditInput {
  orderId: string;
  changes: Array<{
    type: "add" | "remove" | "update";
    lineItemId?: string;
    newVariantId?: string;
    quantity: number;
  }>;
  actorId?: string;
  reason?: string;
}

export interface ProposeOrderEditResult {
  orderEditId: string;
  differenceDueMinor: number;
  status: "proposed";
}

export class ProposeOrderEditUseCase {
  private static readonly MAX_CHANGES = 200;
  private static readonly MIN_QUANTITY = 1;

  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly orderEditRepository: IOrderEditRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  /**
   * Create a proposed order edit (shadow copy) and persist it for review/approval.
   * - Validates inputs and enforces business rules (only unfulfilled orders editable).
   * - Uses domain methods when available to compute monetary variance.
   * - Persists the order edit record transactionally.
   * - Emits non-blocking audit logs and maps repository errors to DomainError.
   */
  async execute(input: ProposeOrderEditInput): Promise<ProposeOrderEditResult> {
    const orderId = (input.orderId ?? "").trim();
    const changes = Array.isArray(input.changes) ? input.changes : [];
    const actorId = (input.actorId ?? "system").trim() || "system";
    const reason = (input.reason ?? "ORDER_EDIT_PROPOSAL").trim();

    // --- Validate inputs
    if (!orderId) {
      throw new DomainError("VALIDATION_ERROR", "orderId is required.");
    }
    if (!changes || changes.length === 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "At least one change must be provided.",
      );
    }
    if (changes.length > ProposeOrderEditUseCase.MAX_CHANGES) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Too many changes. Maximum allowed is ${ProposeOrderEditUseCase.MAX_CHANGES}.`,
      );
    }

    for (const [idx, ch] of changes.entries()) {
      if (!ch || typeof ch !== "object") {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Change at index ${idx} is invalid.`,
        );
      }
      if (!["add", "remove", "update"].includes(ch.type)) {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Change at index ${idx} has invalid type.`,
        );
      }
      toPositiveQuantity(ch.quantity, `Change at index ${idx} quantity`);
      if ((ch.type === "remove" || ch.type === "update") && !ch.lineItemId) {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Change at index ${idx} requires lineItemId for remove/update.`,
        );
      }
      if (ch.type === "add" && !ch.newVariantId) {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Change at index ${idx} requires newVariantId for add.`,
        );
      }
    }

    const auditId = this.idGenerator.generate();
    const startedAt = new Date().toISOString();
    this.logger.info("Proposing order edit", {
      orderId,
      changeCount: changes.length,
      actorId,
      auditId,
    });

    // --- Load order
    let order: Order | null;
    try {
      order = await this.orderRepository.findById(orderId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to load order for edit proposal", {
        err,
        orderId,
        actorId,
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

      throw new DomainError("INTERNAL_ERROR", "Failed to load order.");
    }

    if (!order) {
      this.logger.info("Order not found for edit proposal", {
        orderId,
        actorId,
        auditId,
      });
      throw new DomainError("RESOURCE_NOT_FOUND", "Order not found.");
    }

    // --- Business rule: only unfulfilled orders can be edited
    const fulfillmentStatus = String(
      order.fulfillmentStatus ?? "",
    ).toLowerCase();
    if (fulfillmentStatus !== "unfulfilled") {
      this.logger.info("Attempt to propose edit on non-editable order", {
        orderId,
        fulfillmentStatus,
        actorId,
        auditId,
      });
      throw new DomainError(
        "ORDER_ALREADY_FULFILLED",
        "Cannot modify an order that has already shipped or is being fulfilled.",
      );
    }

    // --- Compute difference using domain method (exact integer minor units)
    let differenceDueMinor: number;
    try {
      differenceDueMinor = toSignedSafeInteger(
        order.calculateEditVariance(changes),
        "Order edit variance",
      );
    } catch (err: unknown) {
      this.logger.error("Failed to compute edit variance", {
        err,
        orderId,
        actorId,
        auditId,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to calculate order edit variance.",
      );
    }

    // --- Build order edit payload
    const orderEditId = this.idGenerator.generate();
    const orderEditPayload = new OrderEdit({
      id: orderEditId,
      orderId: order.id,
      actionType: "proposed_edit",
      reason,
      createdBy: actorId,
      createdAt: startedAt,
      status: "proposed",
      differenceDueMinor,
      proposedChanges: changes.map((c) => ({
        type: c.type,
        lineItemId: c.lineItemId ?? null,
        newVariantId: c.newVariantId ?? null,
        quantity: toPositiveQuantity(c.quantity, "Change quantity"),
      })),
    });

    // --- Persist order edit (transactional)
    try {
      const work = async () => {
        await this.orderEditRepository.save(orderEditPayload);
      };

      await this.transactionManager.execute(work);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist order edit proposal", {
        err,
        orderEditId,
        orderId,
        actorId,
        auditId,
      });

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "INVALID_OPERATION",
          "An order edit with the same identifier already exists.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving order edit.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving order edit.",
        );
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to create order edit proposal.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "ORDER_EDIT_PROPOSED", {
        auditId,
        orderEditId,
        orderId,
        differenceDueMinor: String(orderEditPayload.differenceDueMinor),
        changeCount: String(orderEditPayload.proposedChanges.length),
        createdAt: startedAt,
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for order edit proposal", {
        err: auditErr,
        orderEditId,
        orderId,
      });
    }

    this.logger.info("Order edit proposed", {
      orderEditId,
      orderId,
      differenceDueMinor: orderEditPayload.differenceDueMinor,
      actorId,
    });
    return {
      orderEditId,
      differenceDueMinor: orderEditPayload.differenceDueMinor,
      status: "proposed",
    };
  }
}
