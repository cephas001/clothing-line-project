// apps/api/src/infrastructure/redis/tokenKeys.ts

// Shared Redis key conventions and defensive JWT parsing for the session
// revocation / token denylist infrastructure.
//
// Both JwtTokenService and RedisSessionRevocationService operate on the same
// denylist so a single revoked token is consistently rejected regardless of
// which service wrote the entry. This module is the single owner of those key
// shapes and of the (purely structural) JWT parsing used to derive them.
//
// The revocation identifier is the JWT SIGNATURE (the third segment of
// `header.payload.signature`), never the whole token. Decoding here is limited
// to extracting the numeric `exp` claim for TTL computation; it is NOT used for
// any authentication decision (signature verification is jsonwebtoken's job).

/** Redis key prefix for the token denylist: `denylist:token:<signature>`. */
export const DENYLIST_TOKEN_PREFIX = "denylist:token:";

/** Redis key prefix for the per-user active-session index: `session:user:<userId>`. */
export const USER_SESSIONS_PREFIX = "session:user:";

/** A JWT segment is unpadded base64url (RFC 7515). */
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Build the denylist key for a token signature. */
export function revocationKey(signature: string): string {
  return `${DENYLIST_TOKEN_PREFIX}${signature}`;
}

/** Build the per-user session index key. */
export function userSessionsKey(userId: string): string {
  return `${USER_SESSIONS_PREFIX}${userId}`;
}

/**
 * Extract the signature segment of a JWT without trusting its contents.
 * Returns `null` for anything that is not a well-formed three-segment
 * base64url JWT so callers can avoid constructing keys (or Redis calls) from
 * malformed input. Never throws.
 */
export function extractJwtSignature(token: string): string | null {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  const segments = token.split(".");
  if (segments.length !== 3) {
    return null;
  }
  const [header, payload, signature] = segments;
  if (!header || !payload || !signature) {
    return null;
  }
  if (
    !BASE64URL_SEGMENT.test(header) ||
    !BASE64URL_SEGMENT.test(payload) ||
    !BASE64URL_SEGMENT.test(signature)
  ) {
    return null;
  }
  return signature;
}

/**
 * Extract the numeric `exp` claim from a JWT's payload segment for TTL
 * computation. The payload is decoded WITHOUT verification — this is only used
 * to size a denylist entry's lifetime, never to authorize anything. Returns
 * `null` when the token is malformed or carries no usable `exp`.
 */
export function extractJwtExp(token: string): number | null {
  const segments = token.split(".");
  if (segments.length !== 3) {
    return null;
  }
  const payloadSegment = segments[1];
  if (!payloadSegment || !BASE64URL_SEGMENT.test(payloadSegment)) {
    return null;
  }

  let payload: unknown;
  try {
    const decoded = Buffer.from(payloadSegment, "base64url").toString("utf8");
    payload = JSON.parse(decoded);
  } catch {
    return null;
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }
  const exp = (payload as { exp?: unknown }).exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
}
