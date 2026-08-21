// apps/storefront/src/lib/addressPrefill.ts
//
// Authenticated checkout address prefill (Slice 2B, task 1).
//
// Pure rules only — no React, no HTTP. The checkout view fetches the signed-in
// customer's address book (`GET /store/customers/me/addresses`, the SAME
// service function the account page uses — address logic is NOT duplicated)
// and offers a PREFILL of the shipping-address form:
//
//   - The prefill fills EMPTY form fields only; anything the customer already
//     typed is never clobbered.
//   - Prefill NEVER submits: `addressSaved` stays false and no cart mutation
//     fires until the customer explicitly confirms via "SAVE ADDRESS".
//   - Best-effort by design: an empty address book or a failed lookup simply
//     means manual entry, exactly like guest checkout.

import type { Address } from "@clothing-line-project/shared-types";

/** The subset of Address fields mirrored by the checkout address form. */
export type PrefillableField =
  | "firstName"
  | "lastName"
  | "phone"
  | "line1"
  | "city"
  | "state"
  | "postalCode";

/**
 * Choose which saved address to offer as prefill: the default address when
 * one exists, otherwise the first entry. An empty book yields null (no
 * prefill offered).
 */
export function pickPrefillAddress(addresses: Address[]): Address | null {
  if (addresses.length === 0) return null;
  return addresses.find((address) => address.isDefault === true) ?? addresses[0];
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Merge a saved address into the current form state, filling EMPTY fields
 * only. Returns the SAME object reference when nothing would change so
 * callers can setState without spurious re-renders/effect loops.
 */
export function prefillAddressForm<T extends Record<PrefillableField, string>>(
  current: T,
  address: Address | null,
): T {
  if (!address) return current;
  let changed = false;
  const next = { ...current };
  for (const field of Object.keys(current) as PrefillableField[]) {
    const incoming = trimmed(address[field]);
    if (next[field].trim() === "" && incoming !== "") {
      next[field] = incoming;
      changed = true;
    }
  }
  return changed ? next : current;
}

// -----------------------------------------------------------------------------
// F6.6-G002 — prefill request lifecycle.
//
// The fetch of the address book is a ONE-SHOT-per-mount operation that must
// survive React Strict Mode's simulated unmount/remount: the first attempt is
// cancelled mid-flight, and the remount MUST be allowed to start a second
// valid attempt. A boolean "applied" flag set before the fetch resolves
// defeats exactly that (the cancelled run marks it applied; the remount's run
// sees the flag and never retries). The lifecycle below is the fix:
//
//   not_started → in_flight → completed
//        ↑            |
//        └── interrupted (cleanup before completion)
//
//   - canStart is true ONLY for not_started, so a live attempt is never doubled.
//   - interrupted() releases an IN-FLIGHT attempt back to not_started so the
//     remount restarts; a COMPLETED prefill is never redone.
//   - Failures complete the lifecycle (best-effort by design — no retry loops).
// -----------------------------------------------------------------------------

export type PrefillLifecycle = "not_started" | "in_flight" | "completed";

/** True when a fetch attempt may begin (never while one is already live). */
export function prefillCanStart(state: PrefillLifecycle): boolean {
  return state === "not_started";
}

/**
 * Effect cleanup for an attempt that did NOT finish: an in-flight attempt is
 * released so the next valid attempt (Strict Mode remount) may start. A
 * completed prefill stays completed — it is never redone.
 */
export function prefillInterrupted(state: PrefillLifecycle): PrefillLifecycle {
  return state === "in_flight" ? "not_started" : state;
}
