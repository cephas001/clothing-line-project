// apps/api/src/use-cases/cart/InitializeCartSessionUseCase.ts

import { Cart } from "@api/domain/entities/Cart";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { IRegionRepository } from "@api/domain/interfaces/repositories/IRegionRepository";
import { ISalesChannelRepository } from "@api/domain/interfaces/repositories/ISalesChannelRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface InitializeCartSessionInput {
  regionId: string;
  salesChannelId: string;
  email?: string | null;
  countryCode?: string | null;
  actorId?: string | null; // optional: who initiated the session (for audit)
}

export class InitializeCartSessionUseCase {
  constructor(
    private cartRepository: ICartRepository,
    private regionRepository: IRegionRepository,
    private salesChannelRepository: ISalesChannelRepository,
    private auditLogService: IAuditLogService,
    private idGenerator: IIdGenerator,
    private logger: ILogger,
    private transactionManager: ITransactionManager,
  ) {}

  async execute(input: InitializeCartSessionInput): Promise<Cart> {
    // --- Normalize and validate inputs
    const regionId = (input.regionId ?? "").trim();
    const salesChannelId = (input.salesChannelId ?? "").trim();
    const email = input.email ? String(input.email).trim() : null;
    const countryCode = input.countryCode
      ? String(input.countryCode).trim().toUpperCase()
      : null;
    const actorId = input.actorId ? String(input.actorId).trim() : null;

    if (!regionId) {
      throw new DomainError("VALIDATION_ERROR", "regionId is required.");
    }
    if (!salesChannelId) {
      throw new DomainError("VALIDATION_ERROR", "salesChannelId is required.");
    }

    if (email && email.length > 254) {
      throw new DomainError("VALIDATION_ERROR", "email is too long.");
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "email is not a valid email address.",
      );
    }

    if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "countryCode must be an ISO 3166-1 alpha-2 code.",
      );
    }

    // --- Validate contextual boundaries in parallel
    let region;
    let channel;
    try {
      [region, channel] = await Promise.all([
        this.regionRepository.findById(regionId),
        this.salesChannelRepository.findById(salesChannelId),
      ]);
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error(
          "DB connection error while validating region or sales channel",
          { err, regionId, salesChannelId },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while validating context.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error(
          "DB timeout while validating region or sales channel",
          { err, regionId, salesChannelId },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while validating context.",
        );
      }

      this.logger.error(
        "Unexpected error while validating region or sales channel",
        { err, regionId, salesChannelId },
      );
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to validate region or sales channel.",
      );
    }

    if (!region) {
      throw new DomainError(
        "RESOURCE_NOT_FOUND",
        "Specified region does not exist.",
      );
    }
    if (!channel) {
      throw new DomainError(
        "RESOURCE_NOT_FOUND",
        "Specified sales channel does not exist.",
      );
    }

    // --- Instantiate Cart entity
    const newCart = new Cart({
      id: this.idGenerator.generate(),
      regionId,
      salesChannelId,
      email: email ?? null,
      countryCode: countryCode ?? null,
      createdAt: new Date().toISOString(),
    });

    // --- Persist atomically via the transaction manager
    try {
      const saveFn = async () => {
        await this.cartRepository.save(newCart);
      };

      await this.transactionManager.execute(saveFn);

      // --- Audit log (non-blocking)
      try {
        await this.auditLogService.logAction(
          actorId ?? "system",
          "CART_SESSION_INITIALIZED",
          {
            cartId: newCart.id,
            regionId,
            salesChannelId,
            email: newCart.email,
            countryCode: newCart.countryCode,
            createdAt: newCart.createdAt,
          },
        );
      } catch (auditErr: any) {
        this.logger.warn("Audit log failed for cart session initialization", {
          err: auditErr,
          cartId: newCart.id,
        });
      }

      this.logger.info("Cart session initialized", {
        cartId: newCart.id,
        regionId,
        salesChannelId,
      });
      return newCart;
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        // Extremely unlikely for generated IDs, but handle defensively
        this.logger.warn("Duplicate key error while creating cart session", {
          err,
          regionId,
          salesChannelId,
        });
        throw new DomainError(
          "INVALID_OPERATION",
          "A cart session with the same identifier already exists.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("DB connection error while saving cart", {
          err,
          regionId,
          salesChannelId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while creating cart session.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("DB timeout while saving cart", {
          err,
          regionId,
          salesChannelId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while creating cart session.",
        );
      }

      this.logger.error("Failed to persist new cart session", {
        err,
        regionId,
        salesChannelId,
      });
      throw new DomainError("INTERNAL_ERROR", "Failed to create cart session.");
    }
  }
}
