// apps/api/tests/fakes/FakeCryptographyService.ts
//
// In-memory ICryptographyService backed by node:crypto — the webhook-signature
// tests need a REAL HMAC-SHA512 + constant-time comparison, not a stub that
// always says "verified". Records every operation so tests can assert the use
// case actually delegated to the cryptography boundary (and that the comparison
// was constant-time, never a raw string equality).

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ICryptographyService } from "@api/domain/interfaces/services/ICryptographyService";

export interface HmacCall {
  payload: Buffer;
  secretKey: string;
}

export class FakeCryptographyService implements ICryptographyService {
  readonly hmacCalls: HmacCall[] = [];
  private _compareCalls = 0;

  /** Real HMAC-SHA512 (hex). Records the payload + secret for assertions. */
  generateHmacSha512(payload: Buffer, secretKey: string): string {
    this.hmacCalls.push({ payload, secretKey });
    return createHmac("sha512", secretKey).update(payload).digest("hex");
  }

  /**
   * Constant-time comparison. timingSafeEqual throws when the buffers differ
   * in length, so a length mismatch short-circuits to false WITHOUT revealing
   * length via an exception (the signature path must never throw on a
   * mismatched signature).
   */
  constantTimeCompare(hashA: string, hashB: string): boolean {
    this._compareCalls += 1;
    const a = Buffer.from(hashA, "hex");
    const b = Buffer.from(hashB, "hex");
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }

  get compareCalls(): number {
    return this._compareCalls;
  }

  /** The signature a given body would carry under the given secret. */
  sign(body: Buffer, secretKey: string): string {
    return this.generateHmacSha512(body, secretKey);
  }
}