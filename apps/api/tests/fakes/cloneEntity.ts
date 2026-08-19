// apps/api/tests/fakes/cloneEntity.ts
//
// Prototype-preserving deep clone + snapshot contract for the in-memory
// repositories.
//
// The rollback/atomicity tests need a transaction manager that RESTORES
// in-memory state when a unit of work fails. Entities are class instances
// whose domain methods (Payment.markCaptured, Cart.markConverted, ...) MUTATE
// fields in place, so a naive JSON snapshot cannot restore them — the restored
// objects must keep their prototypes or the next method call breaks.
//
// `cloneValue` copies own enumerable fields (including TS-private `_status`
// etc.), recursively cloning plain objects/arrays/Maps while PRESERVING each
// object's prototype chain. Because every mutation in these flows ASSIGNS
// top-level fields (never mutates a nested object's contents), a snapshot
// taken with `cloneValue` is an exact, independent copy of the aggregate.

export function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneValue) as unknown as T;
  }
  if (value instanceof Map) {
    return new Map(
      Array.from(value.entries()).map(([key, entry]) => [
        cloneValue(key),
        cloneValue(entry),
      ]),
    ) as unknown as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }
  const copy: Record<string, unknown> = Object.create(
    Object.getPrototypeOf(value),
  );
  for (const key of Object.keys(value)) {
    copy[key] = cloneValue(
      (value as Record<string, unknown>)[key],
    );
  }
  return copy as T;
}

/**
 * Contract the in-memory repositories implement so a transaction manager can
 * snapshot and restore their full state around a unit of work. This lives in
 * the fakes because it simulates the database transaction a real
 * ITransactionManager provides — repositories themselves never own
 * transactions.
 */
export interface Snapshotable {
  snapshot(): unknown;
  restore(state: unknown): void;
}
