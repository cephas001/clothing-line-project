// apps/api/src/infrastructure/services/RedisSessionRevocationService.ts

// Redis-backed implementation of ISessionRevocationService.
//
// Revocation model:
// - The denylist identifier is the JWT SIGNATURE (third segment), keyed as
//   `denylist:token:<signature>`. The full token is never stored.
// - A per-user session index `session:user:<userId>` holds the signatures of
//   that user's active tokens so all sessions can be revoked in one operation.
//   The index is populated by JwtTokenService.generateAuthToken via
//   registerSessionToken and expires with the same bound as a token lifetime.
//
// Safety:
// - Malformed tokens are never turned into Redis keys (no pollution, no
//   accidental revocation of unrelated tokens).
// - Revocation keys always carry a TTL matching the token's remaining lifetime;
//   already-expired tokens never produce a key.
// - Redis failures are NOT treated as "not revoked": ioredis errors are mapped
//   to RepositoryError (CONNECTION/TIMEOUT/UNKNOWN) and propagate to the
//   caller, matching the existing Postgres repository convention and the
//   use cases' error mapping.
//
// Security: no JWTs, signatures, or credentials are ever logged or included in
// error messages.

import { Redis } from "ioredis";
import { ISessionRevocationService } from "@api/domain/interfaces/services/ISessionRevocationService";
import { ITokenRevocationStore } from "@api/infrastructure/redis/ITokenRevocationStore";
import { toRedisRepositoryError } from "@api/infrastructure/redis/errors";
import {
  extractJwtExp,
  extractJwtSignature,
  revocationKey,
  userSessionsKey,
} from "@api/infrastructure/redis/tokenKeys";

export interface RedisSessionRevocationServiceOptions {
  /** Shared ioredis client, injected by the composition root. */
  redis: Redis;
  /**
   * Upper bound (seconds) used to TTL denylist entries created by a bulk
   * revocation (revokeSessionsForUser) when the exact per-token `exp` is not
   * available. Should match the auth-token lifetime. Default: 3600 (1 hour).
   */
  sessionTtlSeconds?: number;
}

const DEFAULT_SESSION_TTL_SECONDS = 3600;

export class RedisSessionRevocationService
  implements ISessionRevocationService, ITokenRevocationStore
{
  private readonly redis: Redis;
  private readonly sessionTtlSeconds: number;

  constructor(options: RedisSessionRevocationServiceOptions) {
    if (!options.redis) {
      throw new Error("RedisSessionRevocationService requires a Redis client.");
    }
    this.redis = options.redis;
    this.sessionTtlSeconds =
      options.sessionTtlSeconds && options.sessionTtlSeconds > 0
        ? Math.floor(options.sessionTtlSeconds)
        : DEFAULT_SESSION_TTL_SECONDS;
  }

  /** Denylist a single token by signature for its remaining lifetime. */
  async revokeToken(token: string): Promise<void> {
    const signature = extractJwtSignature(token);
    if (!signature) {
      return;
    }
    const ttlSeconds = this.remainingTtlSeconds(token);
    if (ttlSeconds === null) {
      return;
    }
    await this.run(() => this.redis.set(revocationKey(signature), "1", "EX", ttlSeconds));
  }

  /** Register a token's signature in the user's active-session index. */
  async registerSessionToken(token: string, userId: string): Promise<void> {
    const signature = extractJwtSignature(token);
    if (!signature) {
      return;
    }
    const key = userSessionsKey(userId);
    await this.run(() => this.redis.sadd(key, signature));
    await this.run(() => this.redis.expire(key, this.sessionTtlSeconds));
  }

  /** Whether a token's signature is currently denylisted. */
  async isRevoked(token: string): Promise<boolean> {
    const signature = extractJwtSignature(token);
    if (!signature) {
      return false;
    }
    const exists = await this.run(() => this.redis.exists(revocationKey(signature)));
    return exists === 1;
  }

  /** Revoke every registered session for a user and clear the index. */
  async revokeSessionsForUser(userId: string): Promise<void> {
    const key = userSessionsKey(userId);
    const signatures = await this.run(() => this.redis.smembers(key));

    if (signatures.length > 0) {
      const pipeline = this.redis.pipeline();
      for (const signature of signatures) {
        pipeline.set(revocationKey(signature), "1", "EX", this.sessionTtlSeconds);
      }
      await this.run(() => pipeline.exec());
    }

    await this.run(() => this.redis.del(key));
  }

  /** List the signatures currently registered for a user. */
  async listActiveTokensForUser(userId: string): Promise<string[]> {
    return this.run(() => this.redis.smembers(userSessionsKey(userId)));
  }

  /**
   * Seconds until the token's `exp` claim elapses, or `null` when the token is
   * expired (or carries no usable `exp`) — in which case no key is created.
   */
  private remainingTtlSeconds(token: string): number | null {
    const exp = extractJwtExp(token);
    if (exp === null) {
      return null;
    }
    const remaining = exp - Math.floor(Date.now() / 1000);
    return remaining > 0 ? remaining : null;
  }

  /** Run a Redis operation, mapping driver failures to RepositoryError. */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      throw toRedisRepositoryError(err);
    }
  }
}
