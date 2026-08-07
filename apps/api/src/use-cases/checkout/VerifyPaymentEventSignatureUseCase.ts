// apps/api/src/use-cases/checkout/VerifyPaymentEventSignatureUseCase.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ICryptographyService } from "@api/domain/interfaces/services/ICryptographyService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: verify the cryptographic signature of an incoming payment webhook/event.
 *
 * Responsibilities:
 * - Validate and normalize inputs (raw body, signature header, secret key).
 * - Compute expected HMAC using the configured algorithm (HMAC-SHA512).
 * - Perform a constant-time comparison to avoid timing attacks.
 * - Throw a DomainError with an appropriate code and HTTP status on failure.
 * - Emit a non-blocking audit log entry for successful and failed verification attempts.
 * - Log structured events and failures for observability.
 */
export interface VerifyPaymentEventSignatureInput {
  rawBody: Buffer;
  signatureHeader: string;
  secretKey: string;
  actorId?: string;
}

export class VerifyPaymentEventSignatureUseCase {
  constructor(
    private readonly cryptoService: ICryptographyService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  execute(input: VerifyPaymentEventSignatureInput): void {
    const actorId = (input.actorId ?? "").trim() || "system";

    // --- Basic validation
    if (!input || !Buffer.isBuffer(input.rawBody)) {
      this.logger.warn(
        "Payment signature verification failed: invalid rawBody",
        { actorId },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Invalid request body for signature verification.",
      );
    }

    const signatureHeader = (input.signatureHeader ?? "").trim();
    if (!signatureHeader) {
      this.logger.warn(
        "Payment signature verification failed: missing signature header",
        { actorId },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Missing signature header.",
      );
    }

    const secretKey = (input.secretKey ?? "").trim();
    if (!secretKey) {
      this.logger.error(
        "Payment signature verification failed: missing secret key",
        { actorId },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Missing secret key for verification.",
      );
    }

    // --- Compute expected HMAC
    let expectedHash: string;
    try {
      expectedHash = this.cryptoService.generateHmacSha512(
        input.rawBody,
        secretKey,
      );
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Cryptography service failed to generate HMAC", {
        err,
        actorId,
      });
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Cryptography operation timed out.",
        );
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to compute expected signature.",
      );
    }

    // --- Constant-time comparison to avoid timing attacks
    let isVerified: boolean;
    try {
      isVerified = this.cryptoService.constantTimeCompare(
        expectedHash,
        signatureHeader,
      );
    } catch (err: any) {
      this.logger.error(
        "Cryptography service failed during constant-time comparison",
        { err, actorId },
      );
      throw new DomainError("INTERNAL_ERROR", "Failed to verify signature.");
    }

    // --- Audit and logging (non-blocking for success/failure)
    const auditDetails = {
      auditId: this.idGenerator.generate(),
      verified: String(isVerified),
      checkedAt: new Date().toISOString(),
    };

    try {
      this.auditLogService
        .logAction(actorId, "PAYMENT_SIGNATURE_VERIFICATION", auditDetails)
        .catch((auditErr: any) => {
          this.logger.warn(
            "Audit log failed for payment signature verification",
            { err: auditErr, actorId, ...auditDetails },
          );
        });
    } catch (auditErr: any) {
      this.logger.warn(
        "Audit log invocation failed for payment signature verification",
        { err: auditErr, actorId, ...auditDetails },
      );
    }

    if (!isVerified) {
      this.logger.warn(
        "Payment signature verification failed: signature mismatch",
        { actorId },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Cryptographic signature mismatch.",
      );
    }

    this.logger.info("Payment signature verified successfully", { actorId });
    return;
  }
}
