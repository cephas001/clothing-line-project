// apps/api/tests/harness/expect.ts
//
// Zero-dependency assertion helpers for the L6 verification suite. The API
// package deliberately has no test framework installed; this mini harness
// keeps the validation gate honest: typecheck (:typecheck:tests) proves the
// tests are typed, and `pnpm --filter @clothing-line-project/api test` runs
// them via tsx.
//
// Financial invariant tests assert ERROR CODES, not implementation detail:
// `toThrowWithCode` / `rejectsWithCode` compare against the stable ErrorCode
// union, so refactors that preserve behavior stay green.

export class ExpectationFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpectationFailed";
  }
}

function fail(message: string): never {
  throw new ExpectationFailed(message);
}

function format(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).sort();
  const bKeys = Object.keys(bRecord).sort();
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  if (!aKeys.every((key, index) => key === bKeys[index])) {
    return false;
  }
  return aKeys.every((key) => deepEqual(aRecord[key], bRecord[key]));
}

function readErrorCode(err: unknown): string | null {
  if (err instanceof Error) {
    const candidate = (err as { code?: unknown }).code;
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

type SyncOrAsyncFn = () => unknown;

export class Expectation<T = unknown> {
  /** Negated assertions: `expect(x).not.toBe(y)`. */
  get not(): NegatedExpectation<T> {
    return new NegatedExpectation(this.actual);
  }
  constructor(private readonly actual: T) {}

  toBe(expected: T): void {
    if (this.actual !== expected) {
      fail(`Expected ${format(this.actual)} to be ${format(expected)}`);
    }
  }

  toEqual(expected: unknown): void {
    if (!deepEqual(this.actual, expected)) {
      fail(`Expected ${format(this.actual)} to equal ${format(expected)}`);
    }
  }

  toBeNull(): void {
    if (this.actual !== null) {
      fail(`Expected null, got ${format(this.actual)}`);
    }
  }

  toBeDefined(): void {
    if (this.actual === undefined) {
      fail("Expected value to be defined, got undefined");
    }
  }

  toBeUndefined(): void {
    if (this.actual !== undefined) {
      fail(`Expected undefined, got ${format(this.actual)}`);
    }
  }

  toBeTruthy(): void {
    if (!this.actual) {
      fail(`Expected ${format(this.actual)} to be truthy`);
    }
  }

  toBeFalsy(): void {
    if (this.actual) {
      fail(`Expected ${format(this.actual)} to be falsy`);
    }
  }

  toBeGreaterThan(n: number): void {
    if (typeof this.actual !== "number" || this.actual <= n) {
      fail(`Expected ${format(this.actual)} to be greater than ${n}`);
    }
  }

  toBeLessThan(n: number): void {
    if (typeof this.actual !== "number" || this.actual >= n) {
      fail(`Expected ${format(this.actual)} to be less than ${n}`);
    }
  }

  toContain(substring: string): void {
    if (typeof this.actual !== "string" || !this.actual.includes(substring)) {
      fail(`Expected ${format(this.actual)} to contain ${format(substring)}`);
    }
  }

  toMatch(regex: RegExp): void {
    if (typeof this.actual !== "string" || !regex.test(this.actual)) {
      fail(`Expected ${format(this.actual)} to match ${regex}`);
    }
  }

  toHaveLength(length: number): void {
    const actualLength = (this.actual as { length?: unknown }).length;
    if (actualLength !== length) {
      fail(`Expected value to have length ${length}, got ${format(actualLength)}`);
    }
  }

  toBeInstanceOf(ctor: abstract new (...args: never[]) => unknown): void {
    if (!(this.actual instanceof ctor)) {
      fail(`Expected ${format(this.actual)} to be an instance of ${ctor.name}`);
    }
  }

  /**
   * Assert a SYNC function throws an error carrying the given ErrorCode.
   * Financial invariants must fail with a STABLE domain code, never an
   * accidental raw error.
   */
  toThrowWithCode(code: string): void {
    const fn = this.actual as unknown;
    if (typeof fn !== "function") {
      fail("toThrowWithCode requires a function");
    }
    let thrown: unknown;
    try {
      (fn as SyncOrAsyncFn)();
    } catch (err) {
      thrown = err;
    }
    if (thrown === undefined) {
      fail(`Expected function to throw with code ${code}, but it did not throw`);
    }
    const actualCode = readErrorCode(thrown);
    if (actualCode !== code) {
      fail(`Expected error code ${code}, got ${format(thrown)}`);
    }
  }

  /**
   * Assert an ASYNC function (or promise) rejects with an error carrying the
   * given ErrorCode.
   */
  async rejectsWithCode(code: string): Promise<void> {
    const value = this.actual as unknown;
    let thrown: unknown;
    try {
      if (typeof value === "function") {
        await (value as SyncOrAsyncFn)();
      } else if (isThenable(value)) {
        await value;
      } else {
        fail("rejectsWithCode requires a function or promise");
      }
    } catch (err) {
      thrown = err;
    }
    if (thrown === undefined) {
      fail(`Expected promise to reject with code ${code}, but it resolved`);
    }
    const actualCode = readErrorCode(thrown);
    if (actualCode !== code) {
      fail(`Expected error code ${code}, got ${format(thrown)}`);
    }
  }

  /** Assert an async function (or promise) resolves without throwing. */
  async resolves(): Promise<void> {
    const value = this.actual as unknown;
    if (typeof value === "function") {
      await (value as SyncOrAsyncFn)();
    } else if (isThenable(value)) {
      await value;
    } else {
      fail("resolves requires a function or promise");
    }
  }
}

/** Inverted assertions returned by `expect(x).not`. */
export class NegatedExpectation<T = unknown> {
  constructor(private readonly actual: T) {}

  toBe(expected: T): void {
    if (this.actual === expected) {
      fail(`Expected ${format(this.actual)} NOT to be ${format(expected)}`);
    }
  }

  toEqual(expected: unknown): void {
    if (deepEqual(this.actual, expected)) {
      fail(`Expected ${format(this.actual)} NOT to equal ${format(expected)}`);
    }
  }

  toBeNull(): void {
    if (this.actual === null) {
      fail("Expected value NOT to be null");
    }
  }

  toBeDefined(): void {
    if (this.actual !== undefined) {
      fail(`Expected ${format(this.actual)} NOT to be defined`);
    }
  }

  toBeUndefined(): void {
    if (this.actual === undefined) {
      fail("Expected value NOT to be undefined");
    }
  }

  toBeTruthy(): void {
    if (this.actual) {
      fail(`Expected ${format(this.actual)} NOT to be truthy`);
    }
  }

  toBeFalsy(): void {
    if (!this.actual) {
      fail(`Expected ${format(this.actual)} NOT to be falsy`);
    }
  }

  toContain(substring: string): void {
    if (typeof this.actual === "string" && this.actual.includes(substring)) {
      fail(`Expected ${format(this.actual)} NOT to contain ${format(substring)}`);
    }
  }

  toMatch(regex: RegExp): void {
    if (typeof this.actual === "string" && regex.test(this.actual)) {
      fail(`Expected ${format(this.actual)} NOT to match ${regex}`);
    }
  }

  toHaveLength(length: number): void {
    if ((this.actual as { length?: unknown }).length === length) {
      fail(`Expected value NOT to have length ${length}`);
    }
  }

  toBeInstanceOf(ctor: abstract new (...args: never[]) => unknown): void {
    if (this.actual instanceof ctor) {
      fail(`Expected ${format(this.actual)} NOT to be an instance of ${ctor.name}`);
    }
  }

  toThrowWithCode(code: string): void {
    const fn = this.actual as unknown;
    if (typeof fn !== "function") {
      fail("toThrowWithCode requires a function");
    }
    let thrown: unknown;
    try {
      (fn as SyncOrAsyncFn)();
    } catch (err) {
      thrown = err;
    }
    if (thrown !== undefined && readErrorCode(thrown) === code) {
      fail(`Expected function NOT to throw with code ${code}`);
    }
  }
}

export function expect<T>(actual: T): Expectation<T> {
  return new Expectation(actual);
}