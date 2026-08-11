// apps/api/src/infrastructure/services/JwtTokenService.ts

// Infrastructure implementation of ITokenService backed by `jsonwebtoken`
// (HS256 symmetric signing) and a Redis token denylist.
//
// Responsibilities:
// - generateAuthToken: sign a customer access token and register its signature
//   in the per-user session index so it can be revoked later. Registration is
//   fail-closed: if the revocation store cannot be reached the token is NOT
//   issued, so "issue without revocability" never silently happens.
// - verifyToken / verifyPasswordResetToken: verify signature (HS256 only) and
//   map the distinct jsonwebtoken failure modes onto typed JwtTokenError codes.
// - generatePasswordResetToken: short-lived single-use token carrying an opaque
//   id claim (for cross-checking stored metadata) and an ISO expiresAt claim.
// - hashToken / verifyTokenHash: HMAC-SHA256 of the token itself, so callers can
//   persist a one-way fingerprint instead of the raw token.
// - revokePasswordResetToken / revokeToken: denylist by signature with a TTL
//   equal to the token's remaining lifetime (never a permanent entry).
//
// Design notes:
// - The signing secret is REQUIRED at construction (no fallback, no default).
//   Missing/blank secret fails fast rather than producing insecure tokens.
// - The revocation identifier is the token's SIGNATURE, never the whole JWT;
//   the full token is never stored or logged.
// - Domain rules (TTL policy, password rules) live in the use cases; this
//   service only honors the requested expiry/ttl with a defensive minimum.
//
// Security: tokens, signatures, and secrets are never logged or placed in
// error messages.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import {
  PasswordResetTokenClaims,
  PasswordResetTokenIssueResult,
  TokenClaims,
} from "@api/domain/shared/contracts";
import { ITokenRevocationStore } from "@api/infrastructure/redis/ITokenRevocationStore";
import { extractJwtSignature } from "@api/infrastructure/redis/tokenKeys";

/** Discriminating error codes for JWT operations. */
export type JwtTokenErrorCode =
  | "MALFORMED"
  | "INVALID_SIGNATURE"
  | "TOKEN_EXPIRED"
  | "TOKEN_NOT_YET_VALID"
  | "INVALID_PAYLOAD"
  | "CONFIGURATION";

/** Typed error for JWT failures; distinguishable from raw library errors. */
export class JwtTokenError extends Error {
  readonly code: JwtTokenErrorCode;

  constructor(code: JwtTokenErrorCode, message: string) {
    super(message);
    this.name = "JwtTokenError";
    this.code = code;
  }
}

export interface JwtTokenServiceOptions {
  /** HMAC signing secret. REQUIRED — never fall back to a default. */
  secret: string;
  /** Default lifetime for auth tokens. Defaults to "1h". */
  expiresIn?: string | number;
  /** Default TTL for password reset tokens, in seconds. Defaults to 3600. */
  resetTokenTtlSeconds?: number;
  /** Redis-backed denylist / session index. Injected, never constructed here. */
  revocationStore: ITokenRevocationStore;
}

const DEFAULT_EXPIRES_IN = "1h";
const DEFAULT_RESET_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const MIN_RESET_TOKEN_TTL_SECONDS = 60;

export class JwtTokenService implements ITokenService {
  private readonly secret: string;
  private readonly expiresIn: string | number;
  private readonly resetTokenTtlSeconds: number;
  private readonly revocationStore: ITokenRevocationStore;

  constructor(options: JwtTokenServiceOptions) {
    if (!options.revocationStore) {
      throw new JwtTokenError(
        "CONFIGURATION",
        "JwtTokenService requires a revocation store.",
      );
    }
    if (typeof options.secret !== "string" || options.secret.trim().length === 0) {
      throw new JwtTokenError(
        "CONFIGURATION",
        "JwtTokenService requires a non-empty signing secret.",
      );
    }
    this.secret = options.secret;
    this.expiresIn = options.expiresIn ?? DEFAULT_EXPIRES_IN;
    this.resetTokenTtlSeconds = this.clampResetTtl(
      options.resetTokenTtlSeconds ?? DEFAULT_RESET_TOKEN_TTL_SECONDS,
    );
    this.revocationStore = options.revocationStore;
  }

  /**
   * Sign an auth token (HS256) and register its signature in the per-user
   * session index. Fail-closed: registration errors propagate, so a token is
   * never issued without being revocable. Payloads without a string
   * `customerId` cannot be indexed and are still issued (no per-user revoke).
   */
  async generateAuthToken(
    payload: TokenClaims,
    expiresIn?: string | number,
  ): Promise<string> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new JwtTokenError("INVALID_PAYLOAD", "Auth token payload must be an object.");
    }
    const effectiveExpiresIn = (expiresIn ?? this.expiresIn) as jwt.SignOptions["expiresIn"];
    const token = jwt.sign(
      { ...payload, jti: randomUUID() },
      this.secret,
      {
        algorithm: "HS256",
        expiresIn: effectiveExpiresIn,
      },
    );

    const customerId =
      typeof payload.customerId === "string" ? payload.customerId : null;
    if (customerId) {
      await this.revocationStore.registerSessionToken(token, customerId);
    }
    return token;
  }

  /** Verify an auth token's signature and return its claims. */
  async verifyToken(token: string): Promise<TokenClaims> {
    const payload = this.verifyAsObject(token);
    return payload as TokenClaims;
  }

  /**
   * Generate a short-lived, single-use password reset token. Returns an object
   * so callers can persist the opaque `id` (and `expiresAt`) without storing
   * the raw token; a string-only return is deliberately not produced.
   */
  async generatePasswordResetToken(
    customerId: string,
    options?: { ttlSeconds?: number },
  ): Promise<string | PasswordResetTokenIssueResult> {
    if (typeof customerId !== "string" || customerId.length === 0) {
      throw new JwtTokenError(
        "INVALID_PAYLOAD",
        "Password reset token requires a customerId.",
      );
    }
    const ttlSeconds = this.clampResetTtl(
      options?.ttlSeconds ?? this.resetTokenTtlSeconds,
    );
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    const token = jwt.sign(
      { customerId, id, expiresAt },
      this.secret,
      {
        algorithm: "HS256",
        expiresIn: ttlSeconds,
      },
    );

    return { token, id, expiresAt };
  }

  /**
   * One-way fingerprint of a token (HMAC-SHA256 with the signing secret),
   * safe to persist instead of the raw token.
   */
  async hashToken(token: string): Promise<string> {
    return createHmac("sha256", this.secret).update(token).digest("hex");
  }

  /** Verify a password reset token's signature and return its claims. */
  async verifyPasswordResetToken(token: string): Promise<PasswordResetTokenClaims> {
    const payload = this.verifyAsObject(token);
    if (
      typeof payload.customerId !== "string" ||
      payload.customerId.length === 0
    ) {
      throw new JwtTokenError(
        "INVALID_PAYLOAD",
        "Password reset token is missing customerId.",
      );
    }
    const claims: PasswordResetTokenClaims = { customerId: payload.customerId };
    if (typeof payload.id === "string") {
      claims.id = payload.id;
    }
    if (typeof payload.expiresAt === "string") {
      claims.expiresAt = payload.expiresAt;
    }
    return claims;
  }

  /**
   * Constant-time comparison of a raw token against a previously stored
   * fingerprint (see hashToken). Returns `false` on any mismatch or malformed
   * input; never throws.
   */
  async verifyTokenHash(token: string, hash: string): Promise<boolean> {
    if (typeof token !== "string" || typeof hash !== "string" || hash.length === 0) {
      return false;
    }
    let expected: Buffer;
    try {
      expected = Buffer.from(hash, "hex");
    } catch {
      return false;
    }
    const actual = createHmac("sha256", this.secret).update(token).digest();
    if (expected.length !== actual.length) {
      return false;
    }
    return timingSafeEqual(expected, actual);
  }

  /**
   * Denylist a password reset token so a single-use token cannot be reused.
   * The interface names this `userId` but callers pass the reset token itself;
   * we treat the argument as the token to revoke.
   */
  async revokePasswordResetToken(resetToken: string): Promise<void> {
    await this.revocationStore.revokeToken(resetToken);
  }

  /** Denylist a token by signature for its remaining lifetime. */
  async revokeToken(token: string): Promise<void> {
    await this.revocationStore.revokeToken(token);
  }

  /** Shared HS256 verification returning an object payload with mapped errors. */
  private verifyAsObject(token: string): Record<string, unknown> {
    if (typeof token !== "string" || extractJwtSignature(token) === null) {
      throw new JwtTokenError("MALFORMED", "Token is not a well-formed JWT.");
    }

    let payload: unknown;
    try {
      payload = jwt.verify(token, this.secret, {
        algorithms: ["HS256"],
      });
    } catch (err: unknown) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new JwtTokenError("TOKEN_EXPIRED", "Token has expired.");
      }
      if (err instanceof jwt.NotBeforeError) {
        throw new JwtTokenError(
          "TOKEN_NOT_YET_VALID",
          "Token is not valid yet.",
        );
      }
      if (err instanceof jwt.JsonWebTokenError) {
        throw new JwtTokenError(
          "INVALID_SIGNATURE",
          "Token signature is invalid.",
        );
      }
      throw err;
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new JwtTokenError("INVALID_PAYLOAD", "Token payload is not an object.");
    }
    return payload as Record<string, unknown>;
  }

  private clampResetTtl(ttlSeconds: number): number {
    if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds)) {
      throw new JwtTokenError(
        "CONFIGURATION",
        "Reset token TTL must be a finite number of seconds.",
      );
    }
    return Math.max(MIN_RESET_TOKEN_TTL_SECONDS, Math.floor(ttlSeconds));
  }
}
