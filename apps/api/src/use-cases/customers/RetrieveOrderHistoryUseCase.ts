// apps/api/src/use-cases/customers/RetrieveOrderHistoryUseCase.ts
import { Order } from "@api/domain/entities/Order";
import { IOrderReadRepository } from "@api/domain/interfaces/repositories/IOrderReadRepository";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: retrieve a customer's order history (read-only, CQRS).
 *
 * Responsibilities:
 * - Validate and normalize inputs (customerId, pagination).
 * - Enforce sensible pagination limits to avoid large responses.
 * - Call the read-model repository to fetch paginated results.
 * - Map repository errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the read operation.
 * - Return typed results: items and total count.
 */
export interface RetrieveOrderHistoryInput {
  customerId: string;
  limit?: number;
  offset?: number;
  actorId?: string;
}

export class RetrieveOrderHistoryUseCase {
  private static readonly DEFAULT_LIMIT = 10;
  private static readonly MAX_LIMIT = 100;
  private static readonly DEFAULT_OFFSET = 0;

  constructor(
    private readonly orderReadRepository: IOrderReadRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(
    input: RetrieveOrderHistoryInput,
  ): Promise<{ items: Order[]; total: number }> {
    const customerId = (input.customerId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";

    // Normalize and validate pagination
    const rawLimit = Number.isFinite(Number(input.limit))
      ? Math.floor(Number(input.limit))
      : RetrieveOrderHistoryUseCase.DEFAULT_LIMIT;
    const rawOffset = Number.isFinite(Number(input.offset))
      ? Math.max(0, Math.floor(Number(input.offset)))
      : RetrieveOrderHistoryUseCase.DEFAULT_OFFSET;

    const limit = Math.max(
      1,
      Math.min(RetrieveOrderHistoryUseCase.MAX_LIMIT, rawLimit),
    );
    const offset = Math.max(0, rawOffset);

    if (!customerId) {
      throw new DomainError("VALIDATION_ERROR", "customerId is required.");
    }

    this.logger.info("Retrieving order history", {
      customerId,
      limit,
      offset,
      actorId,
    });

    try {
      // The read repository returns a shape like { items: Order[], total: number }
      const results = await this.orderReadRepository.findHistoryByCustomerId(
        customerId,
        limit,
        offset,
      );

      // Defensive normalization of repository response
      const items: Order[] = Array.isArray(results?.items) ? results.items : [];
      const total: number = Number.isFinite(Number(results?.total))
        ? Number(results.total)
        : items.length;

      // Audit log (non-blocking)
      try {
        await this.auditLogService.logAction(
          actorId,
          "ORDER_HISTORY_RETRIEVED",
          {
            auditId: this.idGenerator.generate(),
            customerId,
            limit: String(limit),
            offset: String(offset),
            returnedCount: String(items.length),
            total: String(total),
            retrievedAt: new Date().toISOString(),
          },
        );
      } catch (auditErr: any) {
        this.logger.warn("Audit log failed for order history retrieval", {
          err: auditErr,
          customerId,
        });
      }

      return { items, total };
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to retrieve order history", {
        err,
        customerId,
        limit,
        offset,
      });

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while retrieving order history.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while retrieving order history.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.PERMISSION) {
        throw new DomainError(
          "PERMISSION_DENIED",
          "Insufficient permissions to read order history.",
        );
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to retrieve order history.",
      );
    }
  }
}
