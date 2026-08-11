// apps/api/src/use-cases/customers/CompletePasswordResetUseCase.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ICustomerRepository } from "@api/domain/interfaces/repositories/ICustomerRepository";
import { IHashingService } from "@api/domain/interfaces/services/IHashingService";
import { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import { ISessionRevocationService } from "@api/domain/interfaces/services/ISessionRevocationService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { Customer } from "@api/domain/entities/Customer";
import {
  PasswordResetTokenClaims,
} from "@api/domain/shared/contracts";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: complete a password reset flow.
 *
 * Responsibilities:
 * - Validate inputs and enforce password policy.
 * - Verify the reset token and ensure it maps to a valid customer.
 * - Hash the new password and persist it atomically with invalidation of the reset token metadata.
 * - Revoke existing sessions and the single-use reset token.
 * - Map adapter/repository errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the completion.
 * - Log structured events and failures for observability.
 */
export interface CompletePasswordResetInput {
  resetToken: string;
  newPasswordRaw: string;
  actorId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export class CompletePasswordResetUseCase {
  private static readonly MIN_PASSWORD_LENGTH = 8;
  private static readonly MAX_PASSWORD_LENGTH = 256;

  constructor(
    private readonly customerRepository: ICustomerRepository,
    private readonly hashingService: IHashingService,
    private readonly tokenService: ITokenService,
    private readonly sessionRevocationService: ISessionRevocationService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(input: CompletePasswordResetInput): Promise<void> {
    const resetToken = (input.resetToken ?? "").trim();
    const newPasswordRaw = input.newPasswordRaw ?? "";
    const actorId = (input.actorId ?? "").trim() || "system";
    const ipAddress = (input.ipAddress ?? "").trim() || "unknown";
    const userAgent = (input.userAgent ?? "").trim() || "unknown";

    // --- Validate inputs
    if (!resetToken) {
      throw new DomainError("VALIDATION_ERROR", "resetToken is required.");
    }
    if (!newPasswordRaw || typeof newPasswordRaw !== "string") {
      throw new DomainError("VALIDATION_ERROR", "newPasswordRaw is required.");
    }
    if (
      newPasswordRaw.length <
        CompletePasswordResetUseCase.MIN_PASSWORD_LENGTH ||
      newPasswordRaw.length > CompletePasswordResetUseCase.MAX_PASSWORD_LENGTH
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Password must be between ${CompletePasswordResetUseCase.MIN_PASSWORD_LENGTH} and ${CompletePasswordResetUseCase.MAX_PASSWORD_LENGTH} characters.`,
      );
    }

    // --- Verify reset token
    let tokenPayload: PasswordResetTokenClaims;
    try {
      tokenPayload =
        await this.tokenService.verifyPasswordResetToken(resetToken);
    } catch (err: unknown) {
      this.logger.info("Invalid or expired password reset token presented", {
        err,
        ipAddress,
        userAgent,
      });
      throw new DomainError(
        "UNAUTHORIZED_ACCESS",
        "Invalid or expired reset token.",
      );
    }

    if (!tokenPayload || !tokenPayload.customerId) {
      this.logger.info(
        "Password reset token verification returned no customerId",
        { tokenPayload },
      );
      throw new DomainError(
        "UNAUTHORIZED_ACCESS",
        "Invalid or expired reset token.",
      );
    }

    const customerId = String(tokenPayload.customerId);

    // --- Load customer
    let customer: Customer | null;
    try {
      customer = await this.customerRepository.findById(customerId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error(
        "Failed to fetch customer during password reset completion",
        { err, customerId },
      );
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while completing password reset.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while completing password reset.",
        );
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to complete password reset.",
      );
    }

    if (!customer) {
      this.logger.info("Customer not found for password reset token", {
        customerId,
      });
      throw new DomainError("RESOURCE_NOT_FOUND", "Customer not found.");
    }

    // --- Optional: verify token id or hash matches stored metadata (defense-in-depth)
    try {
      const storedTokenId = customer.passwordResetTokenId ?? null;
      const storedTokenHash = customer.passwordResetTokenHash ?? null;

      if (
        storedTokenId &&
        tokenPayload.id &&
        String(storedTokenId) !== String(tokenPayload.id)
      ) {
        this.logger.info("Reset token id mismatch", {
          customerId,
          tokenPayloadId: tokenPayload.id,
          storedTokenId,
        });
        throw new DomainError(
          "UNAUTHORIZED_ACCESS",
          "Invalid or expired reset token.",
        );
      }

      if (!storedTokenId && storedTokenHash) {
        // If only a hash was stored, verify token via tokenService.hashToken or tokenService.verifyTokenHash
        if (typeof this.tokenService.verifyTokenHash === "function") {
          const matches = await this.tokenService.verifyTokenHash(
            resetToken,
            storedTokenHash,
          );
          if (!matches) {
            this.logger.info("Reset token hash mismatch", { customerId });
            throw new DomainError(
              "UNAUTHORIZED_ACCESS",
              "Invalid or expired reset token.",
            );
          }
        } else {
          // If we cannot verify hash, proceed but log a warning (tokenService should provide verification)
          this.logger.warn(
            "No token id stored and tokenService cannot verify token hash; proceeding with caution",
            { customerId },
          );
        }
      }
    } catch (err: unknown) {
      if (err instanceof DomainError) throw err;
      this.logger.error("Error while validating stored reset token metadata", {
        err,
        customerId,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to validate reset token.",
      );
    }

    // --- Hash new password
    let newPasswordHash: string;
    try {
      newPasswordHash = await this.hashingService.hash(newPasswordRaw);
      if (!newPasswordHash || typeof newPasswordHash !== "string") {
        this.logger.error(
          "Hashing service returned invalid hash for new password",
          { customerId },
        );
        throw new DomainError("INTERNAL_ERROR", "Failed to hash new password.");
      }
    } catch (err: unknown) {
      this.logger.error("Hashing service error while hashing new password", {
        err,
        customerId,
      });
      throw new DomainError("INTERNAL_ERROR", "Failed to hash new password.");
    }

    // --- Persist new password and clear reset metadata atomically
    const nowIso = new Date().toISOString();
    try {
      const persist = async () => {
        // Set new password hash via domain method
        customer.setPasswordHash(newPasswordHash, { updatedAt: nowIso });

        // Clear reset metadata to prevent reuse (incl. request IP)
        customer.clearPasswordResetMetadata();

        // Bump security stamp to invalidate tokens
        customer.bumpSecurityStamp();

        await this.customerRepository.save(customer);
      };

      await this.transactionManager.execute(persist);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist new password for customer", {
        err,
        customerId,
      });

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving new password.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving new password.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        // Unlikely, but handle defensively
        throw new DomainError(
          "INVALID_OPERATION",
          "Concurrent modification detected while updating password.",
        );
      }

      throw new DomainError("INTERNAL_ERROR", "Failed to update password.");
    }

    // --- Revoke existing sessions for the user (best-effort)
    try {
      await this.sessionRevocationService.revokeSessionsForUser(customerId);
    } catch (err: unknown) {
      this.logger.warn(
        "Failed to revoke existing sessions after password reset",
        { err, customerId },
      );
      // Do not fail the flow; continue to revoke the single-use token below
    }

    // --- Revoke the single-use reset token (best-effort)
    try {
      if (typeof this.tokenService.revokePasswordResetToken === "function") {
        await this.tokenService.revokePasswordResetToken(resetToken);
      } else {
        // Fallback: if tokenService supports generic revoke
        await this.tokenService.revokeToken?.(resetToken).catch(() => {});
      }
    } catch (err: unknown) {
      this.logger.warn("Failed to revoke password reset token after use", {
        err,
        customerId,
      });
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(
        actorId,
        "PASSWORD_RESET_COMPLETED",
        {
          auditId: this.idGenerator.generate(),
          customerId,
          ipAddress,
          userAgent,
          completedAt: nowIso,
        },
      );
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for password reset completion", {
        err: auditErr,
        customerId,
      });
    }

    this.logger.info("Password reset completed successfully", {
      customerId,
      ipAddress,
    });
    return;
  }
}
