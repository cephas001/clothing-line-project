// apps/api/src/infrastructure/redis/ITokenRevocationStore.ts

// Infrastructure-internal contract for the Redis-backed token denylist/session
// registry. It exists so JwtTokenService (which must implement
// ITokenService.revokeToken / revokePasswordResetToken) can revoke tokens and
// register sessions WITHOUT depending on ioredis or on the richer
// ISessionRevocationService interface, and so all denylist logic lives in a
// single implementation (RedisSessionRevocationService).
//
// This is intentionally an infrastructure concern, NOT a domain abstraction:
// domain/application layers never import it.

export interface ITokenRevocationStore {
  /**
   * Add a token's signature to the per-user active-session index so that
   * `revokeSessionsForUser` can invalidate it later. Malformed tokens are
   * ignored.
   */
  registerSessionToken(token: string, userId: string): Promise<void>;

  /**
   * Denylist a token by its signature with a TTL matching its remaining
   * lifetime. Malformed or already-expired tokens are no-ops (no permanent
   * keys). Redis failures propagate as RepositoryError.
   */
  revokeToken(token: string): Promise<void>;

  /**
   * Whether a token's signature is currently denylisted. Returns `false` for
   * malformed tokens. Redis failures propagate (never silently "not revoked").
   */
  isRevoked(token: string): Promise<boolean>;
}
