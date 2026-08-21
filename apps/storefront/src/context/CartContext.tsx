"use client";

// apps/storefront/src/context/CartContext.tsx
//
// Server-backed cart state (Slice 4).
//
// The backend is the SINGLE authority for cart contents and money. This
// provider:
//   - Initializes a cart session (POST /store/carts) on mount and persists the
//     session id (src/lib/cart.ts) so the authoritative projection survives
//     page loads.
//   - Runs every mutation (add / update qty / remove / discount / merge /
//     shipping-address / shipping-option) against the API and then RECONCILES
//     with the freshly-fetched Cart projection. No independent pricing engine
//     is maintained: subtotal/tax/line totals shown are the server's
//     cartTotalMinor / taxAmountMinor / unitPriceMinor / lineTotalMinor.
//   - Applies a narrow OPTIMISTIC overlay for snappy UI — quantity deltas on
//     existing lines and pending additions keyed by variant — that carries NO
//     money math and is cleared the moment the server projection lands.
//   - Merges a guest cart into the customer's account on login (the only cart
//     call that requires a bearer JWT).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Cart,
  ShippingAddress,
  ShippingQuote,
} from "@clothing-line-project/shared-types";
import {
  DEFAULT_REGION_CURRENCY,
  DEFAULT_REGION_ID,
  DEFAULT_SALES_CHANNEL_ID,
} from "@/lib/api/client";
import {
  addCartLineItem,
  applyCartDiscount,
  getCart,
  getShippingQuotes,
  initializeCartSession,
  initializePaymentSession,
  mergeGuestCart,
  removeCartLineItem,
  selectShippingOption as selectShippingOptionApi,
  setCartShippingAddress,
  updateCartLineItemQuantity,
} from "@/lib/api/cart";
import { getCatalog } from "@/lib/api/catalog";
import { ApiError, isApiError, normalizeApiError } from "@/lib/api/errors";
import {
  displayCurrencyOf,
  persistCartId,
  readCartId,
} from "@/lib/cart";
import {
  classifyCartDrawerState,
  createFreshSession,
  isStaleSessionError,
  mutateOnActionableSession,
  resolveActionableSession,
  type CartDrawerState,
  type CartSessionApi,
} from "@/lib/cartSession";
import { createFifoQueue } from "@/lib/fifoQueue";
import {
  planQuantityChange,
  planRemoval,
} from "@/lib/cartMutations";
import { toProductViews } from "@/lib/product";
import { useAuth } from "./AuthContext";
import { useToast } from "./ToastContext";
import type {
  CartLine,
  CartPendingAdd,
  ProductView,
  SelectedShipping,
} from "@/lib/types";

export type CartStatus = "loading" | "ready" | "error";

export interface CartContextValue {
  /** Authoritative server projection. */
  cart: Cart | null;
  cartId: string | null;
  status: CartStatus;
  error: ApiError | null;
  /** True while any mutation/reconcile is in flight. */
  syncing: boolean;
  /**
   * G010: the classified drawer presentation state (loading / error / empty /
   * mutating / ready). Distinct by construction — loading NEVER collapses into
   * empty, and mutations are visible without being mistaken for emptiness.
   */
  drawerState: CartDrawerState;
  /** Display projections (resolved against the catalog). */
  lines: CartLine[];
  count: number;
  /** Server-authoritative money — never recomputed client-side. */
  subtotalAmount: number;
  taxAmountMinor: number | null;
  /** Aggregation of server components (subtotal + tax + shipping) for display only. */
  totalAmountMinor: number;
  subtotalCurrency: string;
  shippingQuotes: ShippingQuote[] | null;
  selectedShipping: SelectedShipping | null;
  appliedPromotion: { id: string; code: string } | null;
  isOpen: boolean;
  openCart: () => void;
  closeCart: () => void;
  toggleCart: () => void;
  addToCart: (product: ProductView, variantId: string, qty?: number) => void;
  changeQty: (lineKey: string, delta: number) => void;
  removeLine: (lineKey: string) => void;
  applyDiscount: (code: string) => Promise<void>;
  setShippingAddress: (address: ShippingAddress) => Promise<void>;
  fetchShippingQuotes: () => Promise<ShippingQuote[]>;
  selectShippingOption: (quoteId: string) => Promise<void>;
  initializePayment: (returnUrl?: string) => Promise<{
    authorizationUrl: string;
    reference: string;
  }>;
  refresh: () => Promise<void>;
  /** Re-run session bootstrap (drawer [Retry] recovery after a boot failure). */
  retryBoot: () => Promise<void>;
}

const CartContext = createContext<CartContextValue | undefined>(undefined);

/** Empty shipping-selection state (no selection yet). */
const NO_SHIPPING: SelectedShipping | null = null;

export function CartProvider({ children }: { children: ReactNode }) {
  const { customer, status: authStatus } = useAuth();
  const { showToast } = useToast();

  const [cart, setCart] = useState<Cart | null>(null);
  const [status, setStatus] = useState<CartStatus>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  // Optimistic overlay (quantities/identity only — never money).
  const [pendingDeltas, setPendingDeltas] = useState<Record<string, number>>({});
  const [pendingAdds, setPendingAdds] = useState<Record<string, CartPendingAdd>>({});

  const [shippingQuotes, setShippingQuotes] = useState<ShippingQuote[] | null>(null);
  const [selectedShipping, setSelectedShipping] =
    useState<SelectedShipping | null>(NO_SHIPPING);

  const [catalogViews, setCatalogViews] = useState<ProductView[]>([]);

// Mirrors so the async callbacks never read stale closures.
  const cartRef = useRef<Cart | null>(cart);
  useEffect(() => {
    cartRef.current = cart;
  }, [cart]);

  // Mirror of the optimistic quantity overlay, updated by the SAME callbacks
  // that set state so rapid clicks never read a stale value (the effect-based
  // mirror alone lags a render).
  const pendingDeltasRef = useRef<Record<string, number>>({});
  useEffect(() => {
    pendingDeltasRef.current = pendingDeltas;
  }, [pendingDeltas]);

  // Monotonic reconcile sequence: when multiple projection fetches are in
  // flight, only the LATEST requested reconcile may apply its result. An older
  // response that lands late must never overwrite newer server state.
  const reconcileSeqRef = useRef(0);

  // Serialized mutation queue: mutations run one-at-a-time (FIFO) so reconcile
  // order matches mutation order and each quantity target is computed against a
  // reconciled projection instead of an interleaved one. Session resolution
  // happens at EXECUTION time inside the queue (see runMutation) so a session
  // replacement can never leak stale state into a freshly-created cart.
  const mutationQueueRef = useRef<ReturnType<typeof createFifoQueue> | null>(null);
  if (mutationQueueRef.current === null) mutationQueueRef.current = createFifoQueue();

  /** The injected cart-session API used by the recovery rules (F6 Slice 1). */
  const cartSessionApi = useMemo<CartSessionApi>(
    () => ({
      getCart,
      createCart: () =>
        initializeCartSession({
          regionId: DEFAULT_REGION_ID,
          salesChannelId: DEFAULT_SALES_CHANNEL_ID,
        }),
      readPersistedId: readCartId,
      persistId: persistCartId,
      isActionable: (cart) => cart.status === "active" && !cart.frozen,
    }),
    [],
  );

  /**
   * Replace local state with the authoritative server projection. The ref is
   * updated SYNCHRONOUSLY (the effect-based mirror alone lags until the next
   * render): a session replacement mid-queue must repoint every subsequent
   * read/reconcile at the new cart immediately, or a freshly-created session
   * could be reconciled against the previous cart's id.
   */
  const applyCart = useCallback((next: Cart) => {
    cartRef.current = next;
    setCart(next);
    setStatus("ready");
    setError(null);
    pendingDeltasRef.current = {};
    setPendingDeltas({});
    setPendingAdds({});
  }, []);

  /** Create, persist and apply a fresh session (G001/G002 recovery). */
  const startFreshSession = useCallback(async (): Promise<Cart> => {
    const fresh = await createFreshSession(cartSessionApi);
    applyCart(fresh);
    return fresh;
  }, [cartSessionApi, applyCart]);

  const notifyError = useCallback(
    (err: unknown) => {
      const apiErr = isApiError(err) ? err : normalizeApiError(err);
      setError(apiErr);
      showToast(apiErr.message);
    },
    [showToast],
  );

  /** Fetch the authoritative projection for the current session and reconcile. */
  const reconcile = useCallback(async (): Promise<Cart> => {
    const id = cartRef.current?.id;
    if (!id) throw new ApiError({ status: 0, code: "NETWORK_ERROR", message: "No cart session." });
    const seq = reconcileSeqRef.current + 1;
    reconcileSeqRef.current = seq;
    const next = await getCart(id);
    // A response that is no longer the latest requested reconcile is dropped —
    // an older in-flight fetch must never overwrite newer state.
    if (seq !== reconcileSeqRef.current) return next;
    // If the session was REPLACED mid-flight (stale/terminal recovery created a
    // fresh cart), this projection belongs to the old session — never apply it.
    if (cartRef.current?.id !== id) return next;
    applyCart(next);
    return next;
  }, [applyCart]);

  /**
   * Run a mutation, then reconcile with the returned backend projection.
   * The cart id is resolved at EXECUTION time (inside the serialized queue):
   *   - a terminal cart (converted/frozen) is replaced by a fresh session;
   *   - a stale session (404) is replaced and the SAME mutation retried once;
   *   - non-404 failures surface and are never silently discarded.
   */
  const runMutation = useCallback(
    async (operation: (cartId: string) => Promise<void>): Promise<void> => {
      setSyncing(true);
      try {
        const outcome = await mutateOnActionableSession({
          api: cartSessionApi,
          current: cartRef.current,
          mutate: operation,
        });
        // A fresh session clears the optimistic overlay and repoints the ref so
        // the following reconcile targets the new cart, never the old one.
        if (outcome.fresh) applyCart(outcome.cart);
        await reconcile();
      } catch (err) {
        // Roll the optimistic overlay back; the server projection is truth.
        setPendingDeltas({});
        setPendingAdds({});
        notifyError(err);
        // F8: the failed mutation rolled back locally, but the SERVER
        // projection may still have drifted (another device/session mutated
        // the same cart, or a sibling line changed). Best-effort re-sync so
        // the drawer shows server truth instead of a stale snapshot; a failed
        // re-sync is swallowed — it must never mask the original error.
        void reconcile().catch(() => {});
        throw err;
      } finally {
        setSyncing(false);
      }
    },
    [cartSessionApi, applyCart, reconcile, notifyError],
  );

  /**
   * Enqueue a mutation on the serialized queue. Mutations fire in FIFO order;
   * each is followed by a reconcile before the next mutation runs. Errors are
   * surfaced by runMutation (toast + error state); the chain stays alive so
   * subsequent mutations are never starved by a failed one.
   */
  const enqueueMutation = useCallback(
    (operation: (cartId: string) => Promise<void>): Promise<void> => {
      return mutationQueueRef.current!.enqueue(() => runMutation(operation));
    },
    [runMutation],
  );

  // -------------------------------------------------------------------------
  // Session bootstrap: restore or initialize the cart, then hydrate the
  // catalog (needed to resolve line products for display).
  // -------------------------------------------------------------------------
  const restoreSession = useCallback(async (): Promise<void> => {
    const { cart } = await resolveActionableSession(cartSessionApi, cartRef.current);
    applyCart(cart);
  }, [cartSessionApi, applyCart]);

  /** Drawer [Retry] recovery: re-run session bootstrap after a boot failure. */
  const retryBoot = useCallback(async (): Promise<void> => {
    setStatus("loading");
    setError(null);
    try {
      await restoreSession();
    } catch (err) {
      setStatus("error");
      setError(isApiError(err) ? err : normalizeApiError(err));
    }
  }, [restoreSession]);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      try {
        await restoreSession();
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setError(isApiError(err) ? err : normalizeApiError(err));
      }
    };

    getCatalog()
      .then(({ products, categories }) => {
        if (!cancelled) setCatalogViews(toProductViews(products, categories));
      })
      .catch(() => {
        // Catalog is only needed for display; the cart itself still works.
      });

    void boot();
    return () => {
      cancelled = true;
    };
  }, [restoreSession]);

  // -------------------------------------------------------------------------
  // Login merge: bind the guest cart to the authenticated customer. The cart
  // endpoints are guest-checkout friendly, so this only runs when the user
  // actually authenticates with a guest cart still in hand.
  // -------------------------------------------------------------------------
  const mergeWithCustomer = useCallback(async () => {
    const id = cartRef.current?.id;
    const current = cartRef.current;
    const customerId = customer?.id;
    if (!id || !customerId || !current) return;
    if (current.customerId) return; // already customer-bound
    setSyncing(true);
    try {
      await mergeGuestCart(id, { guestCartId: id, customerId });
      // After merge the guest cart is either reassigned to the customer or was
      // absorbed into their existing active cart (whose id the client cannot
      // know). Read the guest cart back:
      try {
        const merged = await getCart(id);
        persistCartId(merged.id);
        applyCart(merged);
      } catch (err) {
        // 404 = the guest cart was absorbed — start a fresh session. Any OTHER
        // failure is surfaced and the current state is preserved (never a
        // silent fresh cart that could discard a live merge).
        if (isStaleSessionError(err)) {
          await startFreshSession();
          return;
        }
        notifyError(err);
      }
    } catch (err) {
      notifyError(err);
    } finally {
      setSyncing(false);
    }
  }, [applyCart, notifyError, startFreshSession, customer?.id]);

  useEffect(() => {
    if (authStatus === "authenticated" && status === "ready") {
      void mergeWithCustomer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, status]);

  // -------------------------------------------------------------------------
  // Mutations — optimistic quantity/identity overlay + authoritative reconcile.
  // -------------------------------------------------------------------------
  const addToCart = useCallback(
    (product: ProductView, variantId: string, qty = 1) => {
      const existing = cartRef.current?.items.find(
        (item) => item.variantId === variantId,
      );
      if (existing) {
        setPendingDeltas((prev) => ({
          ...prev,
          [existing.id]: (prev[existing.id] ?? 0) + qty,
        }));
      } else {
        const variant = product.variants.find((v) => v.id === variantId) ?? null;
        setPendingAdds((prev) => {
          const cur = prev[variantId];
          return {
            ...prev,
            [variantId]: {
              variantId,
              qty: (cur?.qty ?? 0) + qty,
              product,
              variant,
            },
          };
        });
      }
      setIsOpen(true);
      // The cart id is resolved at EXECUTION time inside the queue, so adds
      // during boot/loading or after a session replacement target the right
      // cart — never a stale or terminal one.
      enqueueMutation((cartId) =>
        addCartLineItem(cartId, { variantId, quantity: qty }),
      ).catch(() => {
        // Error already surfaced (toast + error state) by runMutation.
      });
    },
    [enqueueMutation],
  );

  const changeQty = useCallback(
    (lineKey: string, delta: number) => {
      const line = cartRef.current?.items.find((item) => item.id === lineKey);
      if (!line) return;
      // F8 — pure planning rule (lib/cartMutations): the target accumulates on
      // top of the pending overlay (rapid clicks coalesce), crossing zero
      // becomes a REMOVE, and a click on a line whose removal is already
      // queued is a no-op instead of a duplicate DELETE.
      const plan = planQuantityChange(
        {
          currentQty: line.quantity,
          pendingDelta: pendingDeltasRef.current[lineKey] ?? 0,
        },
        delta,
      );
      if (plan.action === "noop") return;
      pendingDeltasRef.current = {
        ...pendingDeltasRef.current,
        [lineKey]: plan.nextPending,
      };
      setPendingDeltas(pendingDeltasRef.current);
      if (plan.action === "remove") {
        enqueueMutation((cartId) => removeCartLineItem(cartId, lineKey)).catch(() => {});
      } else {
        enqueueMutation((cartId) =>
          updateCartLineItemQuantity(cartId, lineKey, { quantity: plan.target }),
        ).catch(() => {});
      }
    },
    [enqueueMutation],
  );

  const removeLine = useCallback(
    (lineKey: string) => {
      const line = cartRef.current?.items.find((item) => item.id === lineKey);
      if (!line) return;
      // F8 — idempotent removal: once the overlay drives this line to zero a
      // removal is already queued; a second click (double-click race) must
      // not enqueue another DELETE that would 404 and toast a false error.
      const plan = planRemoval({
        currentQty: line.quantity,
        pendingDelta: pendingDeltasRef.current[lineKey] ?? 0,
      });
      if (plan.action === "noop") return;
      pendingDeltasRef.current = {
        ...pendingDeltasRef.current,
        [lineKey]: plan.nextPending,
      };
      setPendingDeltas(pendingDeltasRef.current);
      enqueueMutation((cartId) => removeCartLineItem(cartId, lineKey)).catch(() => {});
    },
    [enqueueMutation],
  );

  const applyDiscount = useCallback(
    async (code: string): Promise<void> => {
      await enqueueMutation((cartId) => applyCartDiscount(cartId, { code }));
      showToast("Discount applied.");
    },
    [enqueueMutation, showToast],
  );

  // -------------------------------------------------------------------------
  // Checkout flow
  // -------------------------------------------------------------------------
  const setShippingAddress = useCallback(
    async (address: ShippingAddress): Promise<void> => {
      const id = cartRef.current?.id;
      if (!id) return;
      setShippingQuotes(null);
      setSelectedShipping(NO_SHIPPING);
      await enqueueMutation(() => setCartShippingAddress(id, { shippingAddress: address }));
    },
    [enqueueMutation],
  );

  const fetchShippingQuotes = useCallback(async (): Promise<ShippingQuote[]> => {
    const id = cartRef.current?.id;
    if (!id) return [];
    const quotes = await getShippingQuotes(id);
    setShippingQuotes(quotes);
    return quotes;
  }, []);

  const selectShippingOption = useCallback(
    async (quoteId: string): Promise<void> => {
      const id = cartRef.current?.id;
      if (!id) return;
      const selected = await selectShippingOptionApi(id, { quoteId });
      setSelectedShipping(selected);
      await reconcile();
    },
    [reconcile],
  );

  const initializePayment = useCallback(
    async (returnUrl?: string) => {
      const id = cartRef.current?.id;
      if (!id) {
        throw new ApiError({ status: 0, code: "NETWORK_ERROR", message: "No cart session." });
      }
      const result = await initializePaymentSession(id, { returnUrl });
      await reconcile();
      return result;
    },
    [reconcile],
  );

  const refresh = useCallback(async (): Promise<void> => {
    await reconcile();
  }, [reconcile]);

  // -------------------------------------------------------------------------
  // Derived display state. Money is ALWAYS the server projection; the overlay
  // only adjusts quantities/identity.
  // -------------------------------------------------------------------------
  const lines = useMemo<CartLine[]>(() => {
    if (!cart) return [];
    const out: CartLine[] = [];
    for (const item of cart.items) {
      const delta = pendingDeltas[item.id] ?? 0;
      const displayQty = item.quantity + delta;
      if (displayQty <= 0) continue;
      const { product, variant } = resolveLine(item.variantId, catalogViews);
      out.push({
        key: item.id,
        variantId: item.variantId ?? null,
        qty: displayQty,
        unitPriceMinor: item.unitPriceMinor,
        lineTotalMinor: item.lineTotalMinor,
        product,
        variant,
        syncing: syncing,
        pending: false,
      });
    }
    for (const add of Object.values(pendingAdds)) {
      out.push({
        key: `pending__${add.variantId}`,
        variantId: add.variantId,
        qty: add.qty,
        unitPriceMinor: add.variant?.priceMinor ?? 0,
        lineTotalMinor: undefined,
        product: add.product,
        variant: add.variant,
        syncing: true,
        pending: true,
      });
    }
    return out;
  }, [cart, pendingDeltas, pendingAdds, catalogViews, syncing]);

  const count = useMemo(
    () => lines.reduce((sum, line) => sum + line.qty, 0),
    [lines],
  );

  const subtotalAmount = cart?.cartTotalMinor ?? 0;
  const taxAmountMinor = cart?.taxAmountMinor ?? null;
  const shippingAmountMinor = selectedShipping?.amountMinor ?? 0;
  // Display-only aggregation of server-authoritative components. The frontend
  // never prices anything; each part is a server value and the sum is never
  // sent to the API (payment amounts are computed server-side).
  const totalAmountMinor =
    subtotalAmount + (taxAmountMinor ?? 0) + shippingAmountMinor;
  // F7 / G032: the display currency is the AUTHORITATIVE `currency` code on
  // the server's Cart projection — never a client-side choice, and no
  // conversion is ever performed. The region default applies only until a
  // cart projection exists.
  const subtotalCurrency = displayCurrencyOf(cart, DEFAULT_REGION_CURRENCY);

  // G010: one classification, computed from the SAME state the UI renders —
  // the drawer can never show "empty" while the session is still loading.
  const drawerState = useMemo<CartDrawerState>(
    () => classifyCartDrawerState({ status, syncing, lineCount: lines.length }),
    [status, syncing, lines.length],
  );

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      cartId: cart?.id ?? null,
      status,
      error,
      syncing,
      drawerState,
      lines,
      count,
      subtotalAmount,
      taxAmountMinor,
      totalAmountMinor,
      subtotalCurrency,
      shippingQuotes,
      selectedShipping,
      appliedPromotion: cart?.appliedPromotion ?? null,
      isOpen,
      openCart: () => setIsOpen(true),
      closeCart: () => setIsOpen(false),
      toggleCart: () => setIsOpen((o) => !o),
      addToCart,
      changeQty,
      removeLine,
      applyDiscount,
      setShippingAddress,
      fetchShippingQuotes,
      selectShippingOption,
      initializePayment,
      refresh,
      retryBoot,
    }),
    [
      cart,
      status,
      error,
      syncing,
      drawerState,
      lines,
      count,
      subtotalAmount,
      taxAmountMinor,
      totalAmountMinor,
      subtotalCurrency,
      shippingQuotes,
      selectedShipping,
      isOpen,
      addToCart,
      changeQty,
      removeLine,
      applyDiscount,
      setShippingAddress,
      fetchShippingQuotes,
      selectShippingOption,
      initializePayment,
      refresh,
      retryBoot,
    ],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

function resolveLine(
  variantId: string | null | undefined,
  catalogViews: ProductView[],
): { product: ProductView | null; variant: CartLine["variant"] } {
  if (!variantId) return { product: null, variant: null };
  for (const view of catalogViews) {
    const variant = view.variants.find((v) => v.id === variantId);
    if (variant) return { product: view, variant };
  }
  return { product: null, variant: null };
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside <CartProvider>");
  return ctx;
}