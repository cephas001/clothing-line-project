// apps/api/src/use-cases/logistics/GenerateDraftOrderUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IDraftOrderRepository } from "@api/domain/interfaces/repositories/IDraftOrderRepository";
import { INotificationOutboxRepository } from "@api/domain/interfaces/repositories/INotificationOutboxRepository";
import { NotificationIntent } from "@api/domain/shared/notifications";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { JsonObject } from "@api/domain/shared/json";
import { DraftOrderRecord } from "@api/domain/shared/contracts";
import {
  toNonNegativeMinorUnits,
  toPositiveQuantity,
} from "@api/utils/moneyUtils";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface GenerateDraftOrderInput {
  email: string;
  items: Array<{ title: string; quantity: number; unitPriceMinor: number }>;
  shippingAddress: JsonObject;
  adminId: string;
  actorId?: string;
  sendInvoice?: boolean;
}

export class GenerateDraftOrderUseCase {
  private static readonly MAX_ITEMS = 200;
  private static readonly MAX_EMAIL_LENGTH = 320;
  private static readonly MAX_SNAPSHOT_SIZE = 200_000;
  private static readonly EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  constructor(
    private readonly draftOrderRepository: IDraftOrderRepository,
    private readonly notificationOutboxRepository: INotificationOutboxRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(input: GenerateDraftOrderInput): Promise<string> {
    const email = (input.email ?? "").trim().toLowerCase();
    const items = Array.isArray(input.items) ? input.items : [];
    const shippingAddress = input.shippingAddress ?? null;
    const adminId = (input.adminId ?? "").trim();
    const actorId = (input.actorId ?? adminId ?? "system").trim() || "system";
    const sendInvoice = input.sendInvoice !== false;

    // --- Validate inputs
    if (!email) {
      throw new DomainError("VALIDATION_ERROR", "email is required.");
    }
    if (
      email.length > GenerateDraftOrderUseCase.MAX_EMAIL_LENGTH ||
      !GenerateDraftOrderUseCase.EMAIL_REGEX.test(email)
    ) {
      throw new DomainError("VALIDATION_ERROR", "email is invalid.");
    }
    if (!adminId) {
      throw new DomainError("VALIDATION_ERROR", "adminId is required.");
    }
    if (!items || items.length === 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "At least one item is required to generate a draft order.",
      );
    }
    if (items.length > GenerateDraftOrderUseCase.MAX_ITEMS) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Too many items. Maximum allowed is ${GenerateDraftOrderUseCase.MAX_ITEMS}.`,
      );
    }

    // Validate each item
    const validatedItems: Array<{
      title: string;
      quantity: number;
      unitPriceMinor: number;
    }> = [];
    for (const [idx, item] of items.entries()) {
      if (!item || typeof item !== "object") {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Item at index ${idx} is invalid.`,
        );
      }
      if (!item.title || typeof item.title !== "string") {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Item at index ${idx} must have a title.`,
        );
      }
      const quantity = toPositiveQuantity(
        item.quantity,
        `Item at index ${idx} quantity`,
      );
      const unitPriceMinor = toNonNegativeMinorUnits(
        item.unitPriceMinor,
        `Item at index ${idx} unitPriceMinor`,
      );
      validatedItems.push({ title: item.title, quantity, unitPriceMinor });
    }

    // Validate shipping address serializability
    try {
      const preview = JSON.stringify(shippingAddress);
      if (
        Buffer.byteLength(preview, "utf8") >
        GenerateDraftOrderUseCase.MAX_SNAPSHOT_SIZE
      ) {
        throw new DomainError(
          "VALIDATION_ERROR",
          "shippingAddress exceeds maximum allowed size.",
        );
      }
    } catch {
      throw new DomainError(
        "VALIDATION_ERROR",
        "shippingAddress must be serializable to JSON.",
      );
    }

    // --- Compute total (exact integer minor-unit arithmetic)
    const totalMinor = validatedItems.reduce(
      (sum, item) => sum + item.unitPriceMinor * item.quantity,
      0,
    );

    // --- Build draft order
    const draftOrderId = this.idGenerator.generate();
    const nowIso = new Date().toISOString();
    const draftOrder: DraftOrderRecord = {
      id: draftOrderId,
      email,
      items: validatedItems,
      shippingAddress,
      totalMinor,
      status: "awaiting_payment",
      createdBy: adminId,
      createdAt: nowIso,
      metadata: {
        createdByActor: actorId,
      },
    };

    // --- Persist draft order + enqueue invoice intent (atomic)
    // L8 PART 3: the invoice notification is appended to the notification
    // outbox INSIDE the same transaction as the draft order save. The recipient
    // is the durable DraftOrderRecord.email and every financial value comes from
    // the same frozen record (draftOrder.totalMinor / draftOrder.items.length) —
    // never recomputed from today's inputs. Delivery is relayed onto the queue
    // AFTER commit by EnqueuePendingNotificationsUseCase and dispatched by the
    // worker; a notification failure can therefore never roll back the draft
    // order, and a draft order is never created without its invoice intent.
    try {
      const work = async () => {
        await this.draftOrderRepository.save(draftOrder);

        if (sendInvoice) {
          const invoiceIntent: NotificationIntent = {
            type: "draft_order_invoice",
            payload: {
              recipient: { email: draftOrder.email },
              draftOrderId: draftOrder.id,
              totalMinor: draftOrder.totalMinor,
              currency: null,
              itemCount: draftOrder.items.length,
              createdAt: draftOrder.createdAt,
            },
          };
          await this.notificationOutboxRepository.append(
            this.idGenerator.generate(),
            invoiceIntent,
          );
        }
      };

      await this.transactionManager.execute(work);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist draft order", {
        err,
        draftOrderId,
        email,
        adminId,
      });

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "DUPLICATE_DRAFT_ORDER",
          "A draft order with the same identifier already exists.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving draft order.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving draft order.",
        );
      }

      throw new DomainError("INTERNAL_ERROR", "Failed to create draft order.");
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "DRAFT_ORDER_CREATED", {
        auditId: this.idGenerator.generate(),
        draftOrderId,
        email,
        totalMinor: String(totalMinor),
        itemCount: String(draftOrder.items.length),
        createdBy: adminId,
        createdAt: nowIso,
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for draft order creation", {
        err: auditErr,
        draftOrderId,
        email,
      });
    }

    this.logger.info("Draft order generated", {
      draftOrderId,
      email,
      totalMinor,
      createdBy: adminId,
    });
    return draftOrderId;
  }
}
