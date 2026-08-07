// apps/api/src/use-cases/logistics/ProcessOrderSwapVarianceUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { ISwapRepository } from "@api/domain/interfaces/repositories/ISwapRepository";
import { IPaymentService } from "@api/domain/interfaces/services/IPaymentService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface ProcessOrderSwapVarianceInput {
  orderId: string;
  returnLineItemId: string;
  returnQuantity: number;
  newVariantId: string;
  newVariantPriceMinor: number;
  actorId?: string;
  paymentRedirectBaseUrl?: string; // optional: where to redirect customer to complete payment
}

export interface ProcessOrderSwapVarianceResult {
  variance: number;
  action: "EVEN_EXCHANGE" | "PAYMENT_REQUIRED" | "REFUND_DISPATCHED";
  paymentUrl?: string | null;
  swapId: string;
}

export class ProcessOrderSwapVarianceUseCase {
  private static readonly MIN_QUANTITY = 1;

  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly swapRepository: ISwapRepository,
    private readonly paymentService: IPaymentService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  /**
   * Calculate the monetary variance for a swap and take the appropriate action:
   * - If customer owes money, create a payment intent and return a payment URL.
   * - If brand owes money, issue a refund via the payment gateway.
   * - If even, persist the swap and return EVEN_EXCHANGE.
   *
   * The method persists a swap record in the swap repository and maps adapter/repo errors
   * to DomainError codes. Side effects (payment/refund) are performed transactionally.
   */
  async execute(
    input: ProcessOrderSwapVarianceInput,
  ): Promise<ProcessOrderSwapVarianceResult> {
    const orderId = (input.orderId ?? "").trim();
    const returnLineItemId = (input.returnLineItemId ?? "").trim();
    const returnQuantity = Number(input.returnQuantity);
    const newVariantId = (input.newVariantId ?? "").trim();
    const newVariantPriceMinor = Math.floor(Number(input.newVariantPriceMinor));
    const actorId = (input.actorId ?? "system").trim() || "system";
    const paymentRedirectBaseUrl = input.paymentRedirectBaseUrl ?? null;

    // --- Validate inputs
    if (!orderId)
      throw new DomainError("VALIDATION_ERROR", "orderId is required.");
    if (!returnLineItemId)
      throw new DomainError(
        "VALIDATION_ERROR",
        "returnLineItemId is required.",
      );
    if (
      !Number.isFinite(returnQuantity) ||
      returnQuantity < ProcessOrderSwapVarianceUseCase.MIN_QUANTITY
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "returnQuantity must be a positive integer.",
      );
    }
    if (!newVariantId)
      throw new DomainError("VALIDATION_ERROR", "newVariantId is required.");
    if (!Number.isFinite(newVariantPriceMinor) || newVariantPriceMinor < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "newVariantPriceMinor must be a non-negative integer.",
      );
    }

    const auditId = this.idGenerator.generate();
    const startedAt = new Date().toISOString();
    this.logger.info("Processing swap variance", {
      orderId,
      returnLineItemId,
      returnQuantity,
      newVariantId,
      newVariantPriceMinor,
      actorId,
      auditId,
    });

    // --- Load order
    let order: any;
    try {
      order = await this.orderRepository.findById(orderId);
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to load order for swap variance", {
        err,
        orderId,
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
      this.logger.info("Order not found for swap variance", {
        orderId,
        auditId,
      });
      throw new DomainError("RESOURCE_NOT_FOUND", "Order not found.");
    }

    // --- Validate return line item exists and quantity is allowed
    const originalItem = Array.isArray(order.lineItems)
      ? order.lineItems.find(
          (li: any) => String(li.id) === String(returnLineItemId),
        )
      : null;
    if (!originalItem) {
      throw new DomainError(
        "INVALID_INPUT",
        "Return line item not found on order.",
      );
    }
    const fulfilledQty = Number(originalItem.fulfilledQuantity ?? 0);
    if (returnQuantity > fulfilledQty) {
      throw new DomainError(
        "INVALID_RETURN_QUANTITY",
        "Cannot return more items than were fulfilled.",
      );
    }

    // --- Compute original prorated value using the domain method
    let originalValueMinor: number;
    try {
      originalValueMinor = Math.floor(
        Number(order.calculateProratedValue(originalItem.id, returnQuantity)),
      );
    } catch (err: any) {
      this.logger.error("Failed to compute original prorated value", {
        err,
        orderId,
        returnLineItemId,
        auditId,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to compute original item value.",
      );
    }

    const newValueMinor = Math.floor(newVariantPriceMinor * returnQuantity);
    const differenceMinor = newValueMinor - originalValueMinor;

    // --- Build swap record
    const swapId = this.idGenerator.generate();
    const swapRecord: any = {
      id: swapId,
      orderId: order.id,
      returnLineItemId,
      returnQuantity,
      newVariantId,
      newVariantPriceMinor,
      originalValueMinor,
      differenceMinor,
      status: "pending",
      createdAt: startedAt,
      createdBy: actorId,
    };

    // --- Persist swap and perform payment/refund side effects transactionally
    try {
      const work = async () => {
        await this.swapRepository.save(swapRecord);

        if (differenceMinor > 0) {
          // Customer owes money: create payment intent / transaction
          // paymentService.initializeTransactionForAmount should return a URL or token
          const paymentResult =
            await this.paymentService.initializeTransactionForAmount(
              order.customerId,
              differenceMinor,
              {
                metadata: { swapId, orderId },
                redirectBaseUrl: paymentRedirectBaseUrl ?? undefined,
              },
            );

          // Persist payment reference on swap if available
          swapRecord.status = "awaiting_payment";
          swapRecord.paymentReference = paymentResult?.reference ?? null;
          swapRecord.paymentUrl = paymentResult?.paymentUrl ?? null;
          await this.swapRepository.save(swapRecord);
        } else if (differenceMinor < 0) {
          // Brand owes customer: issue refund
          // Use order.transactionReference to identify original payment
          if (!order.transactionReference) {
            this.logger.warn(
              "Order missing transactionReference; cannot issue refund automatically",
              { orderId, swapId },
            );
            swapRecord.status = "refund_pending_manual";
            await this.swapRepository.save(swapRecord);
          } else {
            await this.paymentService.issueRefund(
              order.transactionReference,
              Math.abs(differenceMinor),
              {
                metadata: { swapId, orderId },
              },
            );
            swapRecord.status = "refund_dispatched";
            await this.swapRepository.save(swapRecord);
          }
        } else {
          // Even exchange
          swapRecord.status = "even_exchange";
          await this.swapRepository.save(swapRecord);
        }
      };

      await this.transactionManager.execute(work);
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist swap or perform payment/refund", {
        err,
        swapId,
        orderId,
        auditId,
      });

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "INVALID_OPERATION",
          "Swap conflict detected; possible duplicate swap.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving swap.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving swap.",
        );
      }

      // Attempt best-effort compensation: if a payment was created, try to cancel it
      try {
        if (
          differenceMinor > 0 &&
          typeof this.paymentService.cancelTransaction === "function"
        ) {
          await this.paymentService
            .cancelTransaction(swapRecord.paymentReference)
            .catch(() => {});
        }
      } catch {
        /* swallow compensation errors */
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to process swap variance.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "SWAP_VARIANCE_PROCESSED", {
        auditId,
        swapId,
        orderId,
        returnLineItemId,
        returnQuantity: String(returnQuantity),
        newVariantId,
        differenceMinor: String(differenceMinor),
        status: swapRecord.status,
        processedAt: new Date().toISOString(),
      });
    } catch (auditErr: any) {
      this.logger.warn("Audit log failed for swap variance", {
        err: auditErr,
        swapId,
        orderId,
      });
    }

    // --- Prepare result
    if (differenceMinor > 0) {
      this.logger.info("Swap requires customer payment", {
        swapId,
        orderId,
        differenceMinor,
        paymentUrl: swapRecord.paymentUrl,
      });
      return {
        variance: differenceMinor,
        action: "PAYMENT_REQUIRED",
        paymentUrl: swapRecord.paymentUrl ?? undefined,
        swapId,
      };
    }

    if (differenceMinor < 0) {
      const action =
        swapRecord.status === "refund_dispatched"
          ? "REFUND_DISPATCHED"
          : "EVEN_EXCHANGE";
      this.logger.info("Swap resulted in refund or credit", {
        swapId,
        orderId,
        differenceMinor,
        status: swapRecord.status,
      });
      return {
        variance: differenceMinor,
        action,
        paymentUrl: null,
        swapId,
      };
    }

    this.logger.info("Swap is an even exchange", { swapId, orderId });
    return { variance: 0, action: "EVEN_EXCHANGE", paymentUrl: null, swapId };
  }
}
