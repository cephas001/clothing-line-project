// apps/api/src/infrastructure/services/BcryptHashingService.ts

// Infrastructure implementation of IHashingService backed by the `bcrypt`
// package (N-API native addon).
//
// Responsibilities are intentionally narrow:
// - `hash(data)`    -> plaintext to a bcrypt hash (with a freshly generated salt).
// - `compare(data, hashedData)` -> boolean comparison result.
//
// Business rules (password length, complexity, expiration, existence checks)
// belong to the application/domain layer and are deliberately NOT enforced here.
//
// Only the asynchronous bcrypt APIs are used (bcrypt.hash / bcrypt.compare).
// The synchronous *_Sync variants block the event loop and are avoided: hashing
// is CPU-intensive and must stay off the Node.js main thread.
//
// Error policy: genuine bcrypt failures propagate as standard errors. Nothing is
// swallowed, no DomainError is raised (this is infrastructure), and a bcrypt
// failure never degrades into a `false` comparison. The only `false` a caller
// can observe is a valid-but-mismatched password.
//
// Security: no logging of plaintext, hashes, or comparison inputs. No custom
// crypto, salting, or encoding — everything is delegated to bcrypt.

import bcrypt from "bcrypt";
import { IHashingService } from "@api/domain/interfaces/services/IHashingService";

export interface BcryptHashingServiceOptions {
  /**
   * bcrypt cost factor (log2 rounds). Defaults to 12.
   *
   * 12 is the OWASP-recommended baseline for password hashing (2023+) and
   * strikes a reasonable work/time trade-off on commodity hardware. Raise it
   * as hardware improves; lower it only for constrained non-production runs.
   *
   * This is a construction-time value so it can be externalized to
   * environment/configuration by the composition root later.
   */
  saltRounds?: number;
}

/** Valid bcrypt cost factors. bcrypt rejects rounds outside 4..31. */
const MIN_SALT_ROUNDS = 4;
const MAX_SALT_ROUNDS = 31;

export class BcryptHashingService implements IHashingService {
  private readonly saltRounds: number;

  constructor(options: BcryptHashingServiceOptions = {}) {
    const rounds = options.saltRounds ?? 12;
    if (
      !Number.isInteger(rounds) ||
      rounds < MIN_SALT_ROUNDS ||
      rounds > MAX_SALT_ROUNDS
    ) {
      throw new RangeError(
        `saltRounds must be an integer between ${MIN_SALT_ROUNDS} and ${MAX_SALT_ROUNDS}; received ${rounds}.`,
      );
    }
    this.saltRounds = rounds;
  }

  /** Hash `data` with a freshly generated salt using the configured cost factor. */
  async hash(data: string): Promise<string> {
    return bcrypt.hash(data, this.saltRounds);
  }

  /**
   * Compare `data` against a previously generated bcrypt hash.
   * Returns `false` on mismatch; throws when bcrypt itself fails (e.g. the
   * stored value is not a well-formed bcrypt hash).
   */
  async compare(data: string, hashedData: string): Promise<boolean> {
    return bcrypt.compare(data, hashedData);
  }
}
