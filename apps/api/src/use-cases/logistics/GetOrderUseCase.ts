// apps/api/src/use-cases/logistics/GetOrderUseCase.ts

import { Order } from "@api/domain/entities/Order";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: retrieve an immutable order with line items and fulfilment state
 * (read-only).
 *
 * Responsibilities:
 * - Validate and normalize the orderId input.
 * - Load the order aggregate through the repository abstraction.
 * - Enforce customer ownership: orders are permanently bound to a customer, so
 *   a presented identity (derived from the JWT, never from the request body)
 *   MUST own the order or the read is rejected with PERMISSION_DENIED. The
 *   OpenAPI operation is public (security: []), so anonymous reads of an
 *   order's immutable snapshot remain allowed.
 * - Map repository errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the read.
 * - Return the Order aggregate for the transport boundary to project.
 */
export interface GetOrderInput {
  orderId: string;
  /** Optional JWT-derived actor identity; the ONLY identity source. */
  actorId?: string;
}

export class GetOrderUseCase {
  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: GetOrderInput): Promise<Order> {
    const orderId = (input.orderId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || null;

    if (!orderId) {
      throw new DomainError("VALIDATION_ERROR", "orderId is required.");
    }

    let order: Order | null;
    try {
      order = await this.orderRepository.findById(orderId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch order", { err, orderId });

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while fetching order.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while fetching order.",
        );
      }
      throw new DomainError("INTERNAL_ERROR", "Failed to fetch order.");
    }

    if (!order) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Order not found.");
    }

    // Ownership: every order is permanently bound to a customer. A presented
    // identity that differs from the order's owner is a denied read of another
    // customer's resource.
    if (order.customerId && actorId && actorId !== order.customerId) {
      throw new DomainError(
        "PERMISSION_DENIED",
        "The authenticated customer does not own this order.",
      );
    }

    // Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId ?? "system", "ORDER_RETRIEVED", {
        auditId: this.idGenerator.generate(),
        orderId,
        customerId: order.customerId,
        retrievedAt: new Date().toISOString(),
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for order retrieval", {
        err: auditErr,
        orderId,
      });
    }

    this.logger.info("Retrieved order", {
      orderId,
      actorId: actorId ?? null,
    });
    return order;
  }
}