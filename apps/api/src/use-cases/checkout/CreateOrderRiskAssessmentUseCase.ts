// apps/api/src/use-cases/checkout/CreateOrderRiskAssessmentUseCase.ts
import { IRiskAssessmentService } from "@api/domain/interfaces/services/IRiskAssessmentService";
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { JsonObject } from "@api/domain/shared/contracts";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import { Order } from "@api/domain/entities/Order";

/**
 * Use case: create a risk assessment for an order after payment finalization.
 *
 * Responsibilities:
 * - Load the order and short-circuit if it does not exist.
 * - Call the risk assessment service with payment metadata and order context.
 * - Apply a configurable high-risk threshold to decide whether to flag the order for manual review.
 * - Persist any order state changes (flagging) and map adapter/repository errors to DomainError.
 * - Emit a non-blocking audit log entry recording the assessment and outcome.
 * - Log structured events and failures for observability.
 */
export interface CreateOrderRiskAssessmentInput {
  orderId: string;
  paymentMetadata: JsonObject;
  highRiskThreshold?: number; // 0-100, default applied if omitted
  actorId?: string;
}

export class CreateOrderRiskAssessmentUseCase {
  private static readonly DEFAULT_HIGH_RISK_THRESHOLD = 80;

  constructor(
    private readonly riskService: IRiskAssessmentService,
    private readonly orderRepository: IOrderRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: CreateOrderRiskAssessmentInput): Promise<void> {
    const orderId = (input.orderId ?? "").trim();
    const paymentMetadata = input.paymentMetadata ?? {};
    const actorId = (input.actorId ?? "").trim() || "system";
    const highRiskThreshold = Number.isFinite(input.highRiskThreshold ?? NaN)
      ? Math.max(0, Math.min(100, input.highRiskThreshold!))
      : CreateOrderRiskAssessmentUseCase.DEFAULT_HIGH_RISK_THRESHOLD;

    // --- Validate inputs
    if (!orderId) {
      throw new DomainError("VALIDATION_ERROR", "orderId is required.");
    }
    if (typeof paymentMetadata !== "object") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "paymentMetadata must be an object.",
      );
    }

    // --- Load order
    let order: Order | null;
    try {
      order = await this.orderRepository.findById(orderId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to load order for risk assessment", {
        err,
        orderId,
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
        "Failed to load order for risk assessment.",
      );
    }

    // If order does not exist, nothing to do (idempotent)
    if (!order) {
      this.logger.info("Order not found for risk assessment; skipping", {
        orderId,
      });
      return;
    }

    // --- Evaluate risk
    let riskScore: number;
    try {
      // Provide both payment metadata and order context to the risk service
      riskScore = await this.riskService.evaluateRisk({
        orderId: order.id,
        customerId: order.customerId,
        totalMinor: order.totalAmountMinor,
        paymentMetadata,
      });
    } catch (err: unknown) {
      this.logger.error("Risk service evaluation failed", { err, orderId });
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "EXTERNAL_SERVICE_UNAVAILABLE",
          "Risk assessment provider is unavailable.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "EXTERNAL_SERVICE_TIMEOUT",
          "Risk assessment provider timed out.",
        );
      }
      throw new DomainError("INTERNAL_ERROR", "Failed to evaluate order risk.");
    }

    // Defensive normalization of returned score
    if (!Number.isFinite(riskScore) || riskScore < 0) {
      this.logger.warn(
        "Risk service returned invalid score; normalizing to 0",
        { orderId, returnedScore: riskScore },
      );
      riskScore = 0;
    }

    const isHighRisk = riskScore >= highRiskThreshold;

    // --- Apply business action for high risk
    if (isHighRisk) {
      try {
        order.flagForReview({
          reason: "RISK_SCORE_HIGH",
          score: riskScore,
          flaggedAt: new Date().toISOString(),
        });

        await this.orderRepository.save(order);
      } catch (err: unknown) {
        const repoErr = err as RepositoryError | undefined;
        this.logger.error("Failed to persist order flag for high risk", {
          err,
          orderId,
          riskScore,
        });
        if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database connection error while flagging order for review.",
          );
        }
        if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database timeout while flagging order for review.",
          );
        }
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to flag order for manual review.",
        );
      }
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "ORDER_RISK_ASSESSED", {
        auditId: this.idGenerator.generate(),
        orderId,
        riskScore: String(riskScore),
        highRiskThreshold: String(highRiskThreshold),
        isHighRisk: String(isHighRisk),
        assessedAt: new Date().toISOString(),
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for order risk assessment", {
        err: auditErr,
        orderId,
      });
    }

    this.logger.info("Order risk assessment completed", {
      orderId,
      riskScore,
      highRiskThreshold,
      isHighRisk,
    });
    return;
  }
}
