// apps/api/src/use-cases/catalog/SubmitProductReviewUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IReviewRepository } from "@api/domain/interfaces/repositories/IReviewRepository";
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: submit a product review from a verified buyer.
 *
 * Responsibilities:
 * - Validate inputs (rating bounds, comment length).
 * - Ensure the customer has purchased the product (verified buyer rule).
 * - Persist the review atomically via the transaction manager.
 * - Map repository/service errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the review submission.
 * - Log structured events and failures for observability.
 */
export interface SubmitProductReviewInput {
  productId: string;
  customerId: string;
  rating: number;
  comment?: string | null;
  actorId?: string | null;
}

export class SubmitProductReviewUseCase {
  private static readonly MIN_RATING = 1;
  private static readonly MAX_RATING = 5;
  private static readonly MAX_COMMENT_LENGTH = 5000;

  constructor(
    private readonly reviewRepository: IReviewRepository,
    private readonly orderRepository: IOrderRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(input: SubmitProductReviewInput): Promise<void> {
    // --- Normalize and validate inputs
    const productId = (input.productId ?? "").trim();
    const customerId = (input.customerId ?? "").trim();
    const rating = input.rating;
    const comment = input.comment ? String(input.comment).trim() : null;
    const actorId = (input.actorId ?? "").trim() || customerId || "system";

    if (!productId) {
      throw new DomainError("VALIDATION_ERROR", "productId is required.");
    }
    if (!customerId) {
      throw new DomainError("VALIDATION_ERROR", "customerId is required.");
    }
    if (
      !Number.isInteger(rating) ||
      rating < SubmitProductReviewUseCase.MIN_RATING ||
      rating > SubmitProductReviewUseCase.MAX_RATING
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Rating must be an integer between 1 and 5.",
      );
    }
    if (
      comment &&
      comment.length > SubmitProductReviewUseCase.MAX_COMMENT_LENGTH
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Comment cannot exceed ${SubmitProductReviewUseCase.MAX_COMMENT_LENGTH} characters.`,
      );
    }

    // --- Business rule: only verified buyers can leave a review
    let hasPurchased: boolean;
    try {
      hasPurchased = await this.orderRepository.hasCustomerPurchasedProduct(
        customerId,
        productId,
      );
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error(
        "Failed to verify purchase history for review submission",
        { err, customerId, productId },
      );
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while verifying purchase history.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Timeout while verifying purchase history.",
        );
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to verify purchase history.",
      );
    }

    if (!hasPurchased) {
      throw new DomainError(
        "UNAUTHORIZED_REVIEW",
        "You must purchase this product before submitting a review.",
      );
    }

    // --- Prepare review payload
    const review = {
      id: this.idGenerator.generate(),
      productId,
      customerId,
      rating,
      comment: comment ?? null,
      createdAt: new Date().toISOString(),
    };

    // --- Persist review atomically via the transaction manager
    try {
      const persist = async () => {
        await this.reviewRepository.save(review);
      };

      await this.transactionManager.execute(persist);

      // --- Audit log (non-blocking)
      try {
        await this.auditLogService.logAction(
          actorId,
          "PRODUCT_REVIEW_SUBMITTED",
          {
            auditId: this.idGenerator.generate(),
            reviewId: review.id,
            productId,
            customerId,
            rating: String(rating),
            hasComment: String(Boolean(comment)),
            submittedAt: review.createdAt,
          },
        );
      } catch (auditErr: any) {
        this.logger.warn("Audit log failed for product review submission", {
          err: auditErr,
          reviewId: review.id,
          productId,
          customerId,
        });
      }

      this.logger.info("Product review submitted", {
        reviewId: review.id,
        productId,
        customerId,
        rating,
      });
      return;
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist product review", {
        err,
        productId,
        customerId,
      });

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        // Defensive: customer may have already submitted a review for this product
        throw new DomainError(
          "INVALID_OPERATION",
          "A review for this product by the customer already exists.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving review.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving review.",
        );
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to submit product review.",
      );
    }
  }
}
