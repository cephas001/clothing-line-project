// apps/storefront/src/lib/cartSession.ts
//
// Cart session recovery + drawer-state vocabulary (F6 Slice 1).
//
// Pure orchestration over an INJECTED cart API so the recovery rules are
// unit/integration-testable without a DOM. CartContext wires these rules to
// React state; this module owns the rules:
//
//   - G001: a persisted session that the backend 404s is STALE — it is
//     discarded and a fresh session is created and persisted. Non-404 failures
//     (401/403/409/500/network) NEVER become an empty cart; they surface.
//   - G002: terminal carts (converted/frozen) are never revived or mutated; a
//     fresh session replaces them for any subsequent mutation.
//   - Queue safety: mutation cart ids are resolved at EXECUTION time (inside
//     the serialized FIFO queue), so a session replacement can never leak stale
//     state into a freshly-created cart. A mutation that hits a dead session
//     (stale 404) is retried ONCE against the replacement session.
//   - G010: drawer states (loading/error/empty/mutating/ready) are classified
//     here as pure logic so loading can never collapse into empty.

import type { Cart } from "@clothing-line-project/shared-types";
import { isApiError } from "@/lib/api/errors";

/** The injected cart-session API (implemented with the real client in-app). */
export interface CartSessionApi {
  getCart(id: string): Promise<Cart>;
  createCart(): Promise<Cart>;
  readPersistedId(): string | null;
  persistId(id: string): void;
  /** True when the projection is a reusable, non-terminal session. */
  isActionable(cart: Cart): boolean;
}

export interface SessionResolution {
  cart: Cart;
  /** True when a NEW session had to be created (absent / stale / terminal). */
  fresh: boolean;
}

/**
 * G001: an error means "stale session" ONLY when the backend 404s — never for
 * 401/403/409/500 or network failures, which must surface instead of being
 * silently replaced by an empty cart.
 */
export function isStaleSessionError(error: unknown): boolean {
  return isApiError(error) && error.status === 404;
}

/** Create + persist a brand-new session. Never revives an old one. */
export async function createFreshSession(api: CartSessionApi): Promise<Cart> {
  const fresh = await api.createCart();
  api.persistId(fresh.id);
  return fresh;
}

/**
 * Resolve the actionable session for boot or the next mutation:
 *   1. reuse the current cart when it is actionable;
 *   2. otherwise reuse the persisted session when it still exists and is
 *      actionable;
 *   3. otherwise (terminal cart, stale 404, or no session at all) create and
 *      persist a fresh session.
 * Non-404 failures surface — they never silently produce an empty cart.
 */
export async function resolveActionableSession(
  api: CartSessionApi,
  current: Cart | null,
): Promise<SessionResolution> {
  if (current && api.isActionable(current)) {
    return { cart: current, fresh: false };
  }
  if (current) {
    // G002: terminal (converted/frozen) — replace, never revive or mutate it.
    return { cart: await createFreshSession(api), fresh: true };
  }
  const persistedId = api.readPersistedId();
  if (persistedId) {
    try {
      const existing = await api.getCart(persistedId);
      if (api.isActionable(existing)) {
        return { cart: existing, fresh: false };
      }
      // Terminal persisted cart — fall through to a fresh session.
    } catch (error) {
      if (!isStaleSessionError(error)) throw error; // G001: only 404 is stale
    }
  }
  return { cart: await createFreshSession(api), fresh: true };
}

export interface MutationOutcome<T> {
  result: T;
  /** The session the mutation actually ran against (post-recovery). */
  cart: Cart;
  fresh: boolean;
}

/**
 * Queue safety: run a mutation against an actionable session, resolving the
 * cart id at EXECUTION time (never at enqueue time). If the mutation hits a
 * dead session (stale 404), the session is replaced and the SAME mutation is
 * retried ONCE against the fresh cart — stale state from the previous cart can
 * never reach the new one. Non-404 failures propagate untouched.
 */
export async function mutateOnActionableSession<T>(opts: {
  api: CartSessionApi;
  current: Cart | null;
  mutate: (cartId: string) => Promise<T>;
}): Promise<MutationOutcome<T>> {
  const resolution = await resolveActionableSession(opts.api, opts.current);
  try {
    const result = await opts.mutate(resolution.cart.id);
    return { result, cart: resolution.cart, fresh: resolution.fresh };
  } catch (error) {
    if (!isStaleSessionError(error)) throw error;
    const replacement = await createFreshSession(opts.api);
    const result = await opts.mutate(replacement.id);
    return { result, cart: replacement, fresh: true };
  }
}

/** Drawer states — distinct by design; loading is NEVER collapsed into empty. */
export type CartDrawerState = "loading" | "error" | "mutating" | "empty" | "ready";

export interface CartDrawerStateInput {
  status: "loading" | "ready" | "error";
  syncing: boolean;
  lineCount: number;
}

/** G010: classify the drawer presentation state. */
export function classifyCartDrawerState(input: CartDrawerStateInput): CartDrawerState {
  if (input.status === "error") return "error";
  if (input.status === "loading") return "loading";
  if (input.syncing && input.lineCount > 0) return "mutating";
  if (input.lineCount === 0) return "empty";
  return "ready";
}