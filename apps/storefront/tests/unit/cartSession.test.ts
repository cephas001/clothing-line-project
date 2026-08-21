// apps/storefront/tests/unit/cartSession.test.ts
//
// F6 Slice 1 — cart session recovery rules (pure logic, injected API):
//
//   G001  a persisted session the backend 404s is STALE: discarded, replaced
//         by a fresh created+persisted session. Non-404 failures (401/403/
//         409/500/network) NEVER become an empty cart — they surface.
//   G002  terminal carts (converted/frozen) are never revived or mutated; a
//         fresh session replaces them.
//   Queue safety  mutations resolve their cart id at EXECUTION time; a
//         mutation that hits a dead (404) session is retried ONCE against the
//         replacement, so stale state can never reach the new cart.
//   G010  drawer states are classified distinctly — loading NEVER collapses
//         into empty.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  classifyCartDrawerState,
  createFreshSession,
  isStaleSessionError,
  mutateOnActionableSession,
  resolveActionableSession,
  type CartSessionApi,
} from "../../src/lib/cartSession";
import { ApiError } from "../../src/lib/api/errors";
import { makeCart } from "../helpers/fixtures";
import type { Cart } from "@clothing-line-project/shared-types";

/** Call-recording fake of the injected cart-session API. */
function makeFakeApi(options: {
  persistedId?: string | null;
  onGetCart?: (id: string) => Promise<Cart>;
  onCreateCart?: () => Promise<Cart>;
} = {}): CartSessionApi & {
  getCalls: string[];
  createCalls: number;
  persisted: string[];
} {
  const state = {
    getCalls: [] as string[],
    createCalls: 0,
    persisted: [] as string[],
  };
  let created = 0;
  return {
    getCalls: state.getCalls,
    get createCalls() {
      return state.createCalls;
    },
    persisted: state.persisted,
    async getCart(id: string): Promise<Cart> {
      state.getCalls.push(id);
      if (options.onGetCart) return options.onGetCart(id);
      return makeCart({ id });
    },
    async createCart(): Promise<Cart> {
      state.createCalls += 1;
      created += 1;
      const cart = makeCart({ id: `cart-fresh-${created}`, status: "active" });
      if (options.onCreateCart) return options.onCreateCart();
      return cart;
    },
    readPersistedId(): string | null {
      return options.persistedId ?? null;
    },
    persistId(id: string): void {
      state.persisted.push(id);
    },
    isActionable(cart: Cart): boolean {
      return cart.status === "active" && !cart.frozen;
    },
  };
}

function notFound(message = "Cart not found."): ApiError {
  return new ApiError({ status: 404, code: "CART_NOT_FOUND", message });
}

function serverError(): ApiError {
  return new ApiError({
    status: 500,
    code: "INTERNAL_ERROR",
    message: "Backend exploded.",
  });
}

describe("isStaleSessionError (G001 vocabulary)", () => {
  it("treats ONLY a genuine 404 as stale (by status, whatever the code)", () => {
    expect(isStaleSessionError(notFound())).toBe(true);
    expect(
      isStaleSessionError(
        new ApiError({ status: 404, code: "RESOURCE_NOT_FOUND", message: "no" }),
      ),
    ).toBe(true);
  });

  it("never treats 401/403/409/500 as stale", () => {
    expect(isStaleSessionError(new ApiError({ status: 401, code: "UNAUTHORIZED", message: "no" }))).toBe(false);
    expect(isStaleSessionError(new ApiError({ status: 403, code: "PERMISSION_DENIED", message: "no" }))).toBe(false);
    expect(isStaleSessionError(new ApiError({ status: 409, code: "INVALID_OPERATION", message: "no" }))).toBe(false);
    expect(isStaleSessionError(serverError())).toBe(false);
  });

  it("never treats network/unknown failures as stale", () => {
    expect(isStaleSessionError(new TypeError("fetch failed"))).toBe(false);
    expect(isStaleSessionError(undefined)).toBe(false);
    expect(isStaleSessionError(null)).toBe(false);
  });
});

describe("createFreshSession", () => {
  it("creates AND persists a brand-new session", async () => {
    const api = makeFakeApi();
    const cart = await createFreshSession(api);
    expect(api.createCalls).toBe(1);
    expect(api.persisted).toEqual([cart.id]);
  });
});

describe("resolveActionableSession — G001 stale recovery", () => {
  it("a persisted id that 404s is discarded and replaced by a fresh persisted session", async () => {
    const api = makeFakeApi({
      persistedId: "cart-stale",
      onGetCart: async () => {
        throw notFound();
      },
    });
    const resolution = await resolveActionableSession(api, null);
    expect(resolution.fresh).toBe(true);
    expect(resolution.cart.id).toBe("cart-fresh-1");
    expect(api.getCalls).toEqual(["cart-stale"]);
    expect(api.persisted).toEqual(["cart-fresh-1"]);
  });

  it("a 500 on boot surfaces — NO fresh cart is created (never an empty cart)", async () => {
    const api = makeFakeApi({
      persistedId: "cart-live",
      onGetCart: async () => {
        throw serverError();
      },
    });
    await expect(
      async () => resolveActionableSession(api, null),
    ).rejectsWithCode("INTERNAL_ERROR");
    expect(api.getCalls).toEqual(["cart-live"]);
    expect(api.createCalls).toBe(0);
    expect(api.persisted).toEqual([]);
  });

  it("a network failure on boot surfaces — NO fresh cart is created", async () => {
    const api = makeFakeApi({
      persistedId: "cart-live",
      onGetCart: async () => {
        throw new TypeError("fetch failed");
      },
    });
    let caught: unknown = null;
    try {
      await resolveActionableSession(api, null);
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof TypeError).toBe(true);
    expect(api.createCalls).toBe(0);
    expect(api.persisted).toEqual([]);
  });

  it("an actionable persisted cart is reused (no fresh session)", async () => {
    const existing = makeCart({ id: "cart-live", status: "active" });
    const api = makeFakeApi({
      persistedId: "cart-live",
      onGetCart: async (id) => (id === "cart-live" ? existing : makeCart({ id })),
    });
    const resolution = await resolveActionableSession(api, null);
    expect(resolution.fresh).toBe(false);
    expect(resolution.cart.id).toBe("cart-live");
    expect(api.createCalls).toBe(0);
    expect(api.persisted).toEqual([]);
  });

  it("with no session at all, a fresh one is created and persisted", async () => {
    const api = makeFakeApi();
    const resolution = await resolveActionableSession(api, null);
    expect(resolution.fresh).toBe(true);
    expect(api.getCalls).toEqual([]);
    expect(api.createCalls).toBe(1);
    expect(api.persisted).toHaveLength(1);
  });
});

describe("resolveActionableSession — G002 terminal carts", () => {
  it("a CONVERTED current cart is replaced — never revived or mutated", async () => {
    const terminal = makeCart({ id: "cart-done", status: "converted" });
    const api = makeFakeApi();
    const resolution = await resolveActionableSession(api, terminal);
    expect(resolution.fresh).toBe(true);
    expect(resolution.cart.id).toBe("cart-fresh-1");
    // The terminal cart was never fetched back or written to.
    expect(api.getCalls).toEqual([]);
    expect(api.persisted).toEqual(["cart-fresh-1"]);
  });

  it("a FROZEN current cart is replaced — never revived or mutated", async () => {
    const frozen = makeCart({ id: "cart-locked", status: "active", frozen: true });
    const api = makeFakeApi();
    const resolution = await resolveActionableSession(api, frozen);
    expect(resolution.fresh).toBe(true);
    expect(resolution.cart.id).toBe("cart-fresh-1");
    expect(api.getCalls).toEqual([]);
  });

  it("a persisted TERMINAL cart is replaced by a fresh session", async () => {
    const terminal = makeCart({ id: "cart-done", status: "converted" });
    const api = makeFakeApi({
      persistedId: "cart-done",
      onGetCart: async () => terminal,
    });
    const resolution = await resolveActionableSession(api, null);
    expect(resolution.fresh).toBe(true);
    expect(resolution.cart.id).toBe("cart-fresh-1");
    expect(api.getCalls).toEqual(["cart-done"]);
    expect(api.persisted).toEqual(["cart-fresh-1"]);
  });
});

describe("mutateOnActionableSession — queue safety", () => {
  it("runs the mutation against the actionable session's id", async () => {
    const current = makeCart({ id: "cart-live", status: "active" });
    const api = makeFakeApi();
    const seen: string[] = [];
    const outcome = await mutateOnActionableSession({
      api,
      current,
      mutate: async (cartId) => {
        seen.push(cartId);
      },
    });
    expect(seen).toEqual(["cart-live"]);
    expect(outcome.fresh).toBe(false);
    expect(outcome.cart.id).toBe("cart-live");
    expect(api.createCalls).toBe(0);
  });

  it("a 404 mid-mutation replaces the session and retries the SAME mutation ONCE", async () => {
    const current = makeCart({ id: "cart-old", status: "active" });
    const api = makeFakeApi();
    const attempts: string[] = [];
    const outcome = await mutateOnActionableSession({
      api,
      current,
      mutate: async (cartId) => {
        attempts.push(cartId);
        if (cartId === "cart-old") throw notFound();
      },
    });
    expect(attempts).toEqual(["cart-old", "cart-fresh-1"]);
    expect(outcome.fresh).toBe(true);
    expect(outcome.cart.id).toBe("cart-fresh-1");
    expect(api.persisted).toEqual(["cart-fresh-1"]);
  });

  it("a 404 on the RETRY too propagates (no infinite recreation loop)", async () => {
    const current = makeCart({ id: "cart-old", status: "active" });
    const api = makeFakeApi();
    let attempts = 0;
    await expect(
      async () =>
        mutateOnActionableSession({
          api,
          current,
          mutate: async () => {
            attempts += 1;
            throw notFound();
          },
        }),
    ).rejectsWithCode("CART_NOT_FOUND");
    expect(attempts).toBe(2);
    expect(api.createCalls).toBe(1);
  });

  it("a NON-404 failure propagates untouched — no replacement session is created", async () => {
    const current = makeCart({ id: "cart-live", status: "active" });
    const api = makeFakeApi();
    let attempts = 0;
    await expect(
      async () =>
        mutateOnActionableSession({
          api,
          current,
          mutate: async () => {
            attempts += 1;
            throw serverError();
          },
        }),
    ).rejectsWithCode("INTERNAL_ERROR");
    expect(attempts).toBe(1);
    expect(api.createCalls).toBe(0);
    expect(api.persisted).toEqual([]);
  });

  it("a queued follow-up mutation resolves the REPLACEMENT session's id at execution time", async () => {
    // Mirrors CartContext: a synchronous `current` holder repointed by
    // applyCart, mutations serialized FIFO, each resolving its id lazily.
    let current: Cart | null = makeCart({ id: "cart-old", status: "active" });
    const api = makeFakeApi();
    const executedAgainst: string[] = [];

    const runMutation = async (mutate: (cartId: string) => Promise<void>) => {
      const outcome = await mutateOnActionableSession({ api, current, mutate });
      if (outcome.fresh) current = outcome.cart;
    };

    // First queued mutation discovers the session died (404) and replaces it.
    await runMutation(async (cartId) => {
      executedAgainst.push(cartId);
      if (cartId === "cart-old") throw notFound();
    });
    // Second queued mutation must target the NEW cart — never stale state.
    await runMutation(async (cartId) => {
      executedAgainst.push(cartId);
    });

    // [old attempt, retry on replacement, queued follow-up on replacement]
    expect(executedAgainst).toEqual(["cart-old", "cart-fresh-1", "cart-fresh-1"]);
    expect(current?.id).toBe("cart-fresh-1");
  });
});

describe("classifyCartDrawerState — G010", () => {
  it("loading is LOADING even with zero lines (never collapsed into empty)", () => {
    expect(classifyCartDrawerState({ status: "loading", syncing: false, lineCount: 0 })).toBe("loading");
  });

  it("error takes precedence while the session is unusable", () => {
    expect(classifyCartDrawerState({ status: "error", syncing: false, lineCount: 0 })).toBe("error");
    expect(classifyCartDrawerState({ status: "error", syncing: true, lineCount: 2 })).toBe("error");
  });

  it("a settled projection with lines and no sync in flight is READY", () => {
    expect(classifyCartDrawerState({ status: "ready", syncing: false, lineCount: 3 })).toBe("ready");
  });

  it("a settled projection with zero lines is EMPTY", () => {
    expect(classifyCartDrawerState({ status: "ready", syncing: false, lineCount: 0 })).toBe("empty");
  });

  it("an in-flight mutation over existing lines is MUTATING (not ready, not empty)", () => {
    expect(classifyCartDrawerState({ status: "ready", syncing: true, lineCount: 2 })).toBe("mutating");
  });

  it("all five states are mutually distinct", () => {
    const states = [
      classifyCartDrawerState({ status: "loading", syncing: false, lineCount: 0 }),
      classifyCartDrawerState({ status: "error", syncing: false, lineCount: 0 }),
      classifyCartDrawerState({ status: "ready", syncing: true, lineCount: 1 }),
      classifyCartDrawerState({ status: "ready", syncing: false, lineCount: 0 }),
      classifyCartDrawerState({ status: "ready", syncing: false, lineCount: 1 }),
    ];
    expect(new Set(states).size).toBe(5);
  });
});
