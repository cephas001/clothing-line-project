// apps/api/src/use-cases/customers/RevokeCustomerSessionUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ISessionRevocationService } from "@api/domain/interfaces/services/ISessionRevocationService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: revoke a single active session token or revoke all sessions for a user.
 *
 * Responsibilities:
 * - Validate input token or user context.
 * - Delegate revocation to the sessionRevocationService (infrastructure).
 * - Map adapter/service errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the revocation attempt and outcome.
 * - Log structured events and failures for observability.
 */
export interface RevokeCustomerSessionInput {
  activeToken?: string; // Single token to revoke (preferred)
  revokeAllForUserId?: string; // Alternative: revoke all sessions for a user
  actorId?: string; // Who initiated the revocation (admin/system/customer)
  reason?: string; // Optional reason for audit
}

export class RevokeCustomerSessionUseCase {
  constructor(
    private readonly sessionRevocationService: ISessionRevocationService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: RevokeCustomerSessionInput): Promise<void> {
    const activeToken = (input.activeToken ?? "").trim() || undefined;
    const revokeAllForUserId =
      (input.revokeAllForUserId ?? "").trim() || undefined;
    const actorId = (input.actorId ?? "system").trim() || "system";
    const reason = (input.reason ?? "MANUAL_REVOCATION").trim();

    // Validate that at least one target is provided
    if (!activeToken && !revokeAllForUserId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Either activeToken or revokeAllForUserId must be provided.",
      );
    }

    const auditId = this.idGenerator.generate();
    const attemptedAt = new Date().toISOString();

    // --- Revoke a single token
    if (activeToken) {
      try {
        // The adapter is responsible for parsing the token and writing the signature to the revocation store with correct TTL
        await this.sessionRevocationService.revokeToken(activeToken);

        // Audit log (non-blocking)
        try {
          await this.auditLogService.logAction(
            actorId,
            "SESSION_TOKEN_REVOKED",
            {
              auditId,
              tokenPreview: activeToken.slice(0, 8) + "...",
              reason,
              revokedAt: attemptedAt,
            },
          );
        } catch (auditErr: any) {
          this.logger.warn("Audit log failed for token revocation", {
            err: auditErr,
            actorId,
            auditId,
          });
        }

        this.logger.info("Session token revoked", { actorId, auditId });
        return;
      } catch (err: any) {
        const svcErr = err as RepositoryError | undefined;
        this.logger.error("Failed to revoke session token", {
          err,
          actorId,
          auditId,
        });

        if (svcErr?.code === RepositoryErrorCode.CONNECTION) {
          throw new DomainError(
            "EXTERNAL_SERVICE_UNAVAILABLE",
            "Session revocation service unavailable.",
          );
        }
        if (svcErr?.code === RepositoryErrorCode.TIMEOUT) {
          throw new DomainError(
            "EXTERNAL_SERVICE_TIMEOUT",
            "Session revocation service timed out.",
          );
        }
        if (svcErr?.code === RepositoryErrorCode.PERMISSION) {
          throw new DomainError(
            "PERMISSION_DENIED",
            "Insufficient permissions to revoke session token.",
          );
        }

        // Generic fallback
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to revoke session token.",
        );
      }
    }

    // --- Revoke all sessions for a user
    if (revokeAllForUserId) {
      try {
        // Adapter may support revoking all sessions for a user
        if (
          typeof this.sessionRevocationService.revokeSessionsForUser ===
          "function"
        ) {
          await this.sessionRevocationService.revokeSessionsForUser(
            revokeAllForUserId,
          );
        } else {
          // Fallback: if only token-level revocation exists, attempt to obtain active tokens via the service (best-effort)
          if (
            typeof this.sessionRevocationService.listActiveTokensForUser ===
            "function"
          ) {
            const tokens: string[] = await (
              this.sessionRevocationService as any
            ).listActiveTokensForUser(revokeAllForUserId);
            await Promise.all(
              (tokens || []).map((t) =>
                this.sessionRevocationService.revokeToken(t).catch((e) => {
                  this.logger.warn(
                    "Failed to revoke one of the user's tokens during bulk revocation",
                    { err: e, tokenPreview: t.slice(0, 8) + "..." },
                  );
                }),
              ),
            );
          } else {
            // If no mechanism exists, surface a clear error
            throw new DomainError(
              "UNSUPPORTED_OPERATION",
              "Session revocation service does not support bulk revocation for a user.",
            );
          }
        }

        // Audit log (non-blocking)
        try {
          await this.auditLogService.logAction(
            actorId,
            "ALL_SESSIONS_REVOKED_FOR_USER",
            {
              auditId,
              userId: revokeAllForUserId,
              reason,
              revokedAt: attemptedAt,
            },
          );
        } catch (auditErr: any) {
          this.logger.warn("Audit log failed for bulk session revocation", {
            err: auditErr,
            actorId,
            auditId,
            userId: revokeAllForUserId,
          });
        }

        this.logger.info("All sessions revoked for user", {
          userId: revokeAllForUserId,
          actorId,
          auditId,
        });
        return;
      } catch (err: any) {
        if (err instanceof DomainError) throw err;

        const svcErr = err as RepositoryError | undefined;
        this.logger.error("Failed to revoke all sessions for user", {
          err,
          userId: revokeAllForUserId,
          actorId,
          auditId,
        });

        if (svcErr?.code === RepositoryErrorCode.CONNECTION) {
          throw new DomainError(
            "EXTERNAL_SERVICE_UNAVAILABLE",
            "Session revocation service unavailable.",
          );
        }
        if (svcErr?.code === RepositoryErrorCode.TIMEOUT) {
          throw new DomainError(
            "EXTERNAL_SERVICE_TIMEOUT",
            "Session revocation service timed out.",
          );
        }
        if (svcErr?.code === RepositoryErrorCode.PERMISSION) {
          throw new DomainError(
            "PERMISSION_DENIED",
            "Insufficient permissions to revoke user sessions.",
          );
        }

        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to revoke user sessions.",
        );
      }
    }
  }
}
