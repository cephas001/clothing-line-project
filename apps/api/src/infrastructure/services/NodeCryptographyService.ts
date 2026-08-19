// apps/api/src/infrastructure/services/NodeCryptographyService.ts

// Infrastructure implementation of ICryptographyService using only Node.js's
// native `crypto` module (no third-party cryptography package).
//
// Responsibilities:
// - generateHmacSha512: compute an HMAC-SHA512 over the supplied raw Buffer
//   and return it as a lowercase hexadecimal string. The payload is treated as
//   an opaque byte stream: it is never parsed, stringified, or normalized
//   (no JSON round-trips, no whitespace/encoding/property-order/line-ending
//   normalization). HMAC is sensitive to every input byte, so the raw request
//   buffer is exactly what must be signed.
// - constantTimeCompare: compare two hexadecimal digests in constant time via
//   crypto.timingSafeEqual(). Malformed or non-hex input, odd-length hex, and
//   length mismatches safely return `false` instead of throwing (Node's
//   timingSafeEqual throws on unequal Buffer lengths, so the length check is
//   performed before the comparison is attempted).
//
// Security:
// - The secret key is supplied by the caller (secret management lives outside
//   this primitive). There is no default and no silent fallback: a missing or
//   empty key fails fast with a TypeError rather than producing a weak HMAC.
// - A failed or malformed verification NEVER becomes a success: it returns
//   `false`.
// - The raw body, the secret key, the computed HMAC, and any supplied
//   signature are never logged and never placed in error messages.
//
// Error policy: unexpected native crypto failures propagate to the caller
// unchanged (matching the other infrastructure services, e.g.
// BcryptHashingService). Signature mismatches and malformed signatures are
// ordinary outcomes and are reported as `false`, not thrown.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ICryptographyService } from "@api/domain/interfaces/services/ICryptographyService";

/** Lowercase or uppercase hexadecimal, in even-length pairs. */
const HEX_REGEX = /^[0-9a-fA-F]+$/;

/**
 * Node's timingSafeEqual throws when the two Buffers differ in length, so the
 * supplied hex strings are fully validated and equal-length is guaranteed
 * before any cryptographic comparison happens.
 */
export class NodeCryptographyService implements ICryptographyService {
  /**
   * Compute an HMAC-SHA512 over the raw payload bytes and return the digest as
   * a hexadecimal string. The payload is used verbatim — never parsed,
   * stringified, or normalized.
   */
  generateHmacSha512(payload: Buffer, secretKey: string): string {
    if (
      typeof secretKey !== "string" ||
      secretKey.trim().length === 0
    ) {
      throw new TypeError("secretKey must be a non-empty string.");
    }
    return createHmac("sha512", secretKey).update(payload).digest("hex");
  }

  /**
   * Compare two hexadecimal digests in constant time. Returns `false` for any
   * malformed input (non-hex, odd-length, or empty) or when the two digests
   * differ in length. Only valid equal-length hex pairs reach timingSafeEqual.
   */
  constantTimeCompare(hashA: string, hashB: string): boolean {
    if (!isValidHexDigest(hashA) || !isValidHexDigest(hashB)) {
      return false;
    }

    const bufferA = Buffer.from(hashA, "hex");
    const bufferB = Buffer.from(hashB, "hex");

    if (bufferA.length !== bufferB.length) {
      return false;
    }

    return timingSafeEqual(bufferA, bufferB);
  }
}

/** True only for non-empty, even-length hexadecimal strings. */
function isValidHexDigest(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length % 2 === 0 &&
    HEX_REGEX.test(value)
  );
}
