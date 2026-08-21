"use client";

// apps/storefront/src/components/CheckoutView/CheckoutView.tsx
//
// Checkout flow (Slice 6). The backend is authoritative at every step:
//   1. SHIPPING ADDRESS -> PUT /store/carts/{id}/shipping-address (server
//      stores the JSONB address and recomputes regional tax).
//   2. SHIPPING QUOTES  -> POST /store/carts/{id}/shipping-quotes (server
//      fetches provider quotes; amounts/currency are server-sourced).
//   3. OPTION SELECTION  -> POST /store/carts/{id}/shipping-options with ONLY
//      the returned quoteId; the server freezes the amount.
//   4. PAYMENT SESSION   -> POST /store/carts/{id}/payment-sessions with ONLY
//      an optional returnUrl. The server computes the charge authoritatively,
//      persists the payment obligation, and returns the hosted authorization
//      URL the browser is redirected to.
//
// The frontend NEVER marks an order paid, simulates a payment, computes an
// amount, or sends totals/prices/tax/shipping/customerId. After the gateway
// redirects back (returnUrl + ?reference=), this view classifies the return
// (G003) and polls the AUTHORITATIVE cart projection — of the exact cart the
// attempt was initialized against — until the backend confirms payment
// (paymentStatus / status / orderId). The gateway lifecycle stays
// backend-authoritative; cancelled returns are never shown as "still
// confirming" and timeouts are never shown as success or definitive failure.

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useCart } from "@/context/CartContext";
import { useCurrency } from "@/context/CurrencyContext";
import { isApiError } from "@/lib/api/errors";
import { errorMessageOf } from "@/lib/errorPresentation";
import { getCart } from "@/lib/api/cart";
import { getAddresses } from "@/lib/api/customers";
import {
  pickPrefillAddress,
  prefillAddressForm,
  prefillCanStart,
  prefillInterrupted,
  type PrefillLifecycle,
} from "@/lib/addressPrefill";
import {
  MAX_PAYMENT_VERIFY_ATTEMPTS,
  canLinkOrderToAccount,
  classifyGatewayReturn,
  showGuestSignInAffordance,
} from "@/lib/paymentReturn";
import {
  placeOrderReadiness,
  resolveCheckoutViewGate,
} from "@/lib/checkoutGate";
import { presentPurchaseState } from "@/lib/purchasePresentation";
import {
  clearPendingPayment,
  persistOrderReceipt,
  persistPendingPayment,
  readLastOrderReceipt,
  readPendingPayment,
  type OrderReceipt,
  type PendingPaymentRecord,
} from "@/lib/orderReceipt";
import type { Cart, ShippingAddress } from "@clothing-line-project/shared-types";
import OrderSummary from "./OrderSummary";

const COUNTRY_CODE = "NG";

interface AddressForm {
  firstName: string;
  lastName: string;
  phone: string;
  line1: string;
  city: string;
  state: string;
  postalCode: string;
}

const inputClass =
  "w-full border border-ink bg-transparent px-4 py-3 font-mono text-[13px] outline-none focus:border-ink";

export default function CheckoutView() {
  const {
    lines,
    count,
    status,
    error,
    cart,
    syncing,
    subtotalAmount,
    taxAmountMinor,
    totalAmountMinor,
    subtotalCurrency,
    shippingQuotes,
    selectedShipping,
    appliedPromotion,
    setShippingAddress,
    fetchShippingQuotes,
    selectShippingOption,
    initializePayment,
    applyDiscount,
    refresh,
  } = useCart();
  const { format } = useCurrency();

  const [formData, setFormData] = useState<AddressForm>({
    firstName: "",
    lastName: "",
    phone: "",
    line1: "",
    city: "",
    state: "",
    postalCode: "",
  });
  const [addressSaved, setAddressSaved] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);
  const [fetchingQuotes, setFetchingQuotes] = useState(false);
  const [quotesError, setQuotesError] = useState<string | null>(null);
  const [selectingOption, setSelectingOption] = useState(false);
  const [discountError, setDiscountError] = useState<string | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [initializingPayment, setInitializingPayment] = useState(false);
  const [isMobileExpanded, setIsMobileExpanded] = useState<boolean>(false);

  // -------------------------------------------------------------------------
  // Gateway return (G003): classify + poll the authoritative projection of the
  // EXACT cart the attempt was initialized against. Cart-session recovery
  // (Slice 1) replaces a converted cart at boot, so the live context cart can
  // silently become a fresh session mid-verification — the pending-payment
  // record keeps verification pointed at the cart that was actually charged.
  // -------------------------------------------------------------------------
  const { status: authStatus, openAuth } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const returnReference = params.get("reference");

  // Read once per mount: which cart does this reference belong to?
  const [pendingPayment] = useState<PendingPaymentRecord | null>(() =>
    readPendingPayment(),
  );
  const pendingMatches =
    !!pendingPayment && pendingPayment.reference === returnReference;

  const [observedCart, setObservedCart] = useState<Cart | null>(null);
  const [verifyAttempts, setVerifyAttempts] = useState(0);
  const [receipt, setReceipt] = useState<OrderReceipt | null>(() =>
    readLastOrderReceipt(),
  );

  // The projection classification is based on: the direct read of the paid
  // cart when we know it, otherwise the live context cart.
  const observed = observedCart ?? cart;
  const serverConfirmed =
    observed?.paymentStatus === "paid" ||
    observed?.status === "converted" ||
    !!observed?.orderId;

  const gatewayState = classifyGatewayReturn({
    hasReference: !!returnReference,
    reference: returnReference,
    // F6.6-G001: the persisted receipt (shape-validated on read) proves a
    // prior confirmation of THIS reference when session recovery has already
    // replaced the converted cart with a fresh one.
    receiptReference: receipt?.reference ?? null,
    serverConfirmed,
    paymentStatus: observed?.paymentStatus ?? null,
    attempts: verifyAttempts,
    maxAttempts: MAX_PAYMENT_VERIFY_ATTEMPTS,
  });

  /** One verification read. Prefers the recorded attempt's cart; falls back
   * to reconciling the live session when no matching record exists. */
  const fetchVerificationProjection = async (): Promise<Cart | null> => {
    if (pendingMatches && pendingPayment) {
      return getCart(pendingPayment.cartId);
    }
    await refresh();
    return null; // classification falls back to the live context cart
  };

  useEffect(() => {
    if (gatewayState !== "verifying") return;
    let cancelled = false;
    const tick = () => {
      void (async () => {
        try {
          const projection = await fetchVerificationProjection();
          if (!cancelled && projection) setObservedCart(projection);
        } catch {
          // A transient network error must not abort verification.
        }
        if (!cancelled) setVerifyAttempts((t) => t + 1);
      })();
    };
    void tick();
    const timer = window.setInterval(tick, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayState]);

  // G004: on server confirmation, persist the order receipt ONCE so the path
  // to /account/orders/{id} survives reloads and session replacement.
  const receiptOrderId = useRef<string | null>(null);
  useEffect(() => {
    const orderId = observed?.orderId;
    if (!serverConfirmed || !orderId) return;
    if (receiptOrderId.current === orderId) return;
    receiptOrderId.current = orderId;
    const next: OrderReceipt = {
      orderId,
      reference: returnReference,
      confirmedAt: new Date().toISOString(),
    };
    persistOrderReceipt(next);
    setReceipt(next);
    clearPendingPayment();
  }, [serverConfirmed, observed?.orderId, returnReference]);

  // Slice 2B: authenticated address prefill. The signed-in customer's saved
  // address book (the SAME `GET /store/customers/me/addresses` endpoint the
  // account page uses — no duplicated address logic) offers a best-effort
  // prefill of EMPTY form fields only. It NEVER submits: the address reaches
  // the cart only when the customer explicitly confirms via SAVE ADDRESS.
  //
  // F6.6-G002: the attempt follows the pure lifecycle from addressPrefill.ts
  // (not_started → in_flight → completed, interrupted → not_started). Strict
  // Mode's simulated unmount cancels the first in-flight attempt and the
  // remount starts a second valid one; a COMPLETED prefill is never redone,
  // so there are no effect loops.
  const prefillLifecycleRef = useRef<PrefillLifecycle>("not_started");
  useEffect(() => {
    if (authStatus !== "authenticated") return;
    if (!prefillCanStart(prefillLifecycleRef.current)) return;
    prefillLifecycleRef.current = "in_flight";
    let cancelled = false;
    void getAddresses()
      .then((addresses) => {
        if (cancelled) return;
        prefillLifecycleRef.current = "completed";
        setFormData((prev) =>
          prefillAddressForm(prev, pickPrefillAddress(addresses)),
        );
      })
      .catch(() => {
        // Best-effort: a failed lookup leaves manual entry untouched. The
        // lifecycle completes — failures never retry-loop.
        if (!cancelled) prefillLifecycleRef.current = "completed";
      });
    return () => {
      cancelled = true;
      prefillLifecycleRef.current = prefillInterrupted(
        prefillLifecycleRef.current,
      );
    };
  }, [authStatus]);

  const updateField = (field: keyof AddressForm, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setAddressSaved(false);
  };

  // -------------------------------------------------------------------------
  // Flow steps
  // -------------------------------------------------------------------------
  const handleSaveAddress = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingAddress) return;
    setSavingAddress(true);
    setQuotesError(null);
    setPaymentError(null);
    const address: ShippingAddress = {
      firstName: formData.firstName.trim(),
      lastName: formData.lastName.trim(),
      phone: formData.phone.trim(),
      line1: formData.line1.trim(),
      city: formData.city.trim(),
      state: formData.state.trim(),
      postalCode: formData.postalCode.trim(),
      countryCode: COUNTRY_CODE,
      isBusiness: false,
    };
    try {
      await setShippingAddress(address);
      setAddressSaved(true);
      await loadQuotes();
    } catch (err) {
      setQuotesError(
        isApiError(err) ? err.message : "Could not save the shipping address.",
      );
    } finally {
      setSavingAddress(false);
    }
  };

  const loadQuotes = async () => {
    setFetchingQuotes(true);
    setQuotesError(null);
    try {
      await fetchShippingQuotes();
    } catch (err) {
      setQuotesError(
        isApiError(err) ? err.message : "Could not fetch shipping rates.",
      );
    } finally {
      setFetchingQuotes(false);
    }
  };

  const handleSelectOption = async (quoteId: string) => {
    if (selectingOption) return;
    setSelectingOption(true);
    setPaymentError(null);
    try {
      await selectShippingOption(quoteId);
    } catch (err) {
      // Stale quotes (cart changed since fetch) → 409: refresh the rates.
      if (isApiError(err) && (err.status === 409 || err.code === "INVALID_STATE")) {
        setQuotesError("Shipping rates changed — fetching fresh quotes.");
        await loadQuotes();
      } else {
        setQuotesError(
          isApiError(err) ? err.message : "Could not select a shipping option.",
        );
      }
    } finally {
      setSelectingOption(false);
    }
  };

  const handlePlaceOrder = async () => {
    if (initializingPayment) return;
    setInitializingPayment(true);
    setPaymentError(null);
    try {
      const returnUrl = `${window.location.origin}/checkout`;
      const { authorizationUrl, reference } = await initializePayment(returnUrl);
      // Record WHICH cart this attempt belongs to BEFORE leaving, so the
      // return leg verifies that exact cart's authoritative projection.
      if (cart?.id) {
        persistPendingPayment({
          cartId: cart.id,
          reference,
          startedAt: new Date().toISOString(),
        });
      }
      // Redirect to the hosted gateway; the backend owns the charge lifecycle.
      window.location.assign(authorizationUrl);
    } catch (err) {
      setPaymentError(
        isApiError(err)
          ? err.message
          : "Could not start payment. Please try again.",
      );
      setInitializingPayment(false);
    }
  };

  /** Timeout recovery: re-open the verification window and poll again now. */
  const handleCheckAgain = () => {
    setObservedCart(null);
    setVerifyAttempts(0);
  };

  /**
   * Cancelled/not-confirmed recovery: no confirmed payment exists for this
   * checkout — restart the flow cleanly (address → shipping → payment). The
   * backend authorizes every step; nothing about the old attempt is claimed.
   */
  const handleRetryAfterNotConfirmed = () => {
    clearPendingPayment();
    router.replace("/checkout");
  };

  const handleApplyDiscount = async (code: string) => {
    setDiscountError(null);
    try {
      await applyDiscount(code);
    } catch (err) {
      setDiscountError(
        isApiError(err) ? err.message : "That code could not be applied.",
      );
    }
  };

  // -------------------------------------------------------------------------
  // Renders — the full-screen precedence is a PURE rule (lib/checkoutGate.ts):
  // cart loading → cart error → gateway return → empty cart → actionable.
  // -------------------------------------------------------------------------
  const gate = resolveCheckoutViewGate({
    cartStatus: status,
    lineCount: lines.length,
    gatewayReturnState: gatewayState,
  });

  if (gate.kind === "cart-loading") {
    return (
      <div className="flex min-h-[70vh] items-center justify-center px-4">
        <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
          LOADING CART…
        </span>
      </div>
    );
  }

  if (gate.kind === "cart-error") {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 px-4 text-center">
        <h1 className="m-0 font-display text-[clamp(32px,7vw,72px)] font-black uppercase leading-[0.95]">
          CAN&apos;T REACH THE STORE.
        </h1>
        <p className="max-w-md font-mono text-[12px] text-muted">
          {errorMessageOf(error)}
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="cursor-pointer border border-ink bg-transparent px-6 py-3.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2"
        >
          TRY AGAIN
        </button>
      </div>
    );
  }

  if (gate.kind === "gateway-return") {
    // G004: the persistent path to the resulting order — the live projection
    // when present, otherwise the receipt recorded at confirmation time.
    const confirmedOrderId = observed?.orderId ?? receipt?.orderId ?? null;
    const showOrderLink = canLinkOrderToAccount(
      authStatus === "authenticated",
      confirmedOrderId,
    );
    // F9/E4: words and affordances come from the pure presentation rule —
    // success is never inferred beyond the classifier's server signals.
    const presentation = presentPurchaseState({
      state: gatewayState,
      reference: returnReference,
      orderId: confirmedOrderId,
    });
    const isVerifying = gatewayState === "verifying";
    const isConfirmed = gatewayState === "confirmed";

    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 px-4 text-center">
        {presentation.badge && (
          <div className="font-mono text-[11px] tracking-[0.1em] text-muted">
            {presentation.badge}
          </div>
        )}
        {isVerifying ? (
          <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
            {presentation.headline}
          </span>
        ) : (
          <h1
            className={`m-0 font-display font-black uppercase leading-[0.95] ${
              isConfirmed
                ? "text-[clamp(40px,9vw,96px)]"
                : "text-[clamp(32px,7vw,72px)]"
            }`}
          >
            {presentation.headline}
          </h1>
        )}
        {presentation.body && (
          <p
            className={`max-w-md ${
              isConfirmed
                ? "font-display text-[14px] text-muted md:text-[15px]"
                : "font-mono text-[12px] text-muted"
            }`}
          >
            {presentation.body}
          </p>
        )}

        {presentation.recoveryAction === "check-again" && (
          <button
            type="button"
            onClick={handleCheckAgain}
            className="cursor-pointer border border-ink bg-transparent px-6 py-3.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2"
          >
            [ CHECK AGAIN ]
          </button>
        )}
        {presentation.recoveryAction === "restart-checkout" && (
          <button
            type="button"
            onClick={handleRetryAfterNotConfirmed}
            className="cursor-pointer border border-ink bg-transparent px-6 py-3.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2"
          >
            [ TRY AGAIN ]
          </button>
        )}

        {/* G004: the order link renders ONLY for a server-confirmed purchase
            with a server-issued id AND an authenticated viewer. */}
        {isConfirmed && presentation.receiptAvailable && showOrderLink && (
          <div className="flex flex-col items-center gap-2">
            <Link
              href={`/account/orders/${confirmedOrderId}`}
              className="inline-block border border-ink bg-transparent px-6 py-3.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2"
            >
              [ VIEW YOUR ORDER ]
            </Link>
            <span className="font-mono text-[10px] tracking-[0.04em] text-muted">
              You can always find this order in your account.
            </span>
          </div>
        )}
        {isConfirmed && presentation.receiptAvailable && !showOrderLink && (
          <span className="max-w-md font-mono text-[10px] tracking-[0.04em] text-muted">
            {authStatus === "authenticated"
              ? "Your order reference is shown above and in your email."
              : "Create an account with this email any time to follow your orders."}
          </span>
        )}

        {!isVerifying && (
          <Link
            href="/shop"
            className={
              isConfirmed
                ? "inline-block border border-ink bg-transparent px-6 py-3.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2"
                : "inline-block font-mono text-[11px] uppercase tracking-[0.1em] text-muted underline hover:text-ink"
            }
          >
            BACK TO SHOP
          </Link>
        )}
      </div>
    );
  }

  if (gate.kind === "empty-cart") {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 px-4 text-center md:px-8">
        <h1 className="m-0 font-display text-[clamp(40px,9vw,96px)] font-black uppercase leading-[0.95]">
          LOST THE THREAD.
        </h1>
        <Link
          href="/shop"
          className="inline-block border border-ink bg-transparent px-6 py-3.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2"
        >
          BACK TO SHOP
        </Link>
      </div>
    );
  }

  const shippingAmountMinor = selectedShipping?.amountMinor ?? null;
  const shippingLabel = shippingAmountMinor == null
    ? "SELECT AN OPTION"
    : null;
  // F9/E3: payment-entry readiness is a pure rule — both server-backed
  // preconditions (saved address, frozen shipping option) must hold.
  const readiness = placeOrderReadiness({
    addressSaved,
    shippingSelected: !!selectedShipping,
    syncing,
    initializingPayment,
  });
  const canPlaceOrder = readiness.canPlaceOrder;

  return (
    <section className="px-4 pb-14 pt-6 md:px-8 md:pb-24 md:pt-10">
      {/* PAGE HEADING */}
      <div className="mb-2.5 font-mono text-[10px] tracking-[0.06em] text-muted md:mb-3 md:text-[12px] md:tracking-[0.08em]">
        HOME / CHECKOUT
      </div>
      <h1 className="mb-4 mt-0 font-display text-[28px] font-bold uppercase md:mb-5 md:text-[44px]">
        CHECKOUT
      </h1>

      {/* G005: unobtrusive sign-in affordance for guests. Guest checkout is
          never blocked — this is an offer, not a gate. */}
      {showGuestSignInAffordance(authStatus) && (
        <div className="mb-6 flex items-center justify-between gap-4 border border-ink bg-paper px-4 py-3">
          <span className="font-mono text-[10px] tracking-[0.04em] text-muted md:text-[11px]">
            ALREADY HAVE AN ACCOUNT? SIGN IN TO TRACK THIS ORDER.
          </span>
          <button
            type="button"
            onClick={openAuth}
            className="flex-shrink-0 cursor-pointer border border-ink bg-transparent px-4 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink hover:bg-ink hover:text-paper-2 md:text-[11px]"
          >
            SIGN IN
          </button>
        </div>
      )}

      {/* MOBILE COLLAPSIBLE ORDER SUMMARY */}
      <div className="mb-6 md:hidden border border-ink">
        <button
          type="button"
          onClick={() => setIsMobileExpanded((o) => !o)}
          className="flex w-full items-center justify-between px-4 py-3.5 text-left"
        >
          <span className="font-mono text-[11px] uppercase tracking-[0.08em]">
            ORDER SUMMARY ( {count} {count === 1 ? "item" : "items"} )
          </span>
          <span className="flex items-center gap-2 font-mono text-[12px]">
            {format(totalAmountMinor, subtotalCurrency)}
            {isMobileExpanded ? (
              <ChevronUp size={16} strokeWidth={1.75} />
            ) : (
              <ChevronDown size={16} strokeWidth={1.75} />
            )}
          </span>
        </button>

        <AnimatePresence initial={false}>
          {isMobileExpanded && (
            <motion.div
              key="mobile-summary"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden border-t border-ink"
            >
              <div className="p-4">
                <OrderSummary
                  lines={lines}
                  subtotalAmount={subtotalAmount}
                  taxAmountMinor={taxAmountMinor}
                  shippingAmountMinor={shippingAmountMinor}
                  totalAmountMinor={totalAmountMinor}
                  currency={subtotalCurrency}
                  appliedPromotion={appliedPromotion}
                  onApplyDiscount={handleApplyDiscount}
                  discountError={discountError}
                  shippingLabel={shippingLabel}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* MAIN LAYOUT */}
      <div className="grid grid-cols-1 gap-10 md:grid-cols-[1.5fr_1fr] md:gap-16">
        <form onSubmit={(e) => void handleSaveAddress(e)} className="flex flex-col gap-10">
          {/* SHIPPING ADDRESS */}
          <div>
            <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
              SHIPPING ADDRESS
            </h2>
            {addressSaved && (
              <div className="mb-4 border border-ink bg-paper px-4 py-3 font-mono text-[10px] tracking-[0.04em] text-muted">
                ADDRESS SAVED — TAX RECALCULATED BY STORE.
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
              <input
                type="text"
                aria-label="FIRST NAME"
                placeholder="FIRST NAME"
                required
                onChange={(e) => updateField("firstName", e.target.value)}
                value={formData.firstName}
                className={inputClass}
              />
              <input
                type="text"
                aria-label="LAST NAME"
                placeholder="LAST NAME"
                required
                onChange={(e) => updateField("lastName", e.target.value)}
                value={formData.lastName}
                className={inputClass}
              />
              <input
                type="text"
                aria-label="ADDRESS"
                placeholder="ADDRESS"
                required
                onChange={(e) => updateField("line1", e.target.value)}
                value={formData.line1}
                className={`${inputClass} md:col-span-2`}
              />
              <input
                type="text"
                aria-label="CITY"
                placeholder="CITY"
                required
                onChange={(e) => updateField("city", e.target.value)}
                value={formData.city}
                className={inputClass}
              />
              <input
                type="text"
                aria-label="STATE"
                placeholder="STATE"
                required
                value={formData.state}
                onChange={(e) => updateField("state", e.target.value)}
                className={inputClass}
              />
              <input
                type="text"
                aria-label="POSTAL CODE"
                placeholder="POSTAL CODE"
                required
                value={formData.postalCode}
                onChange={(e) => updateField("postalCode", e.target.value)}
                className={inputClass}
              />
              <input
                type="tel"
                aria-label="PHONE"
                placeholder="PHONE"
                required
                value={formData.phone}
                onChange={(e) => updateField("phone", e.target.value)}
                className={inputClass}
              />
            </div>
            <div className="mt-4">
              <button
                type="submit"
                disabled={savingAddress || syncing}
                className="h-12 w-full cursor-pointer border border-ink bg-ink font-mono text-[12px] uppercase tracking-[0.08em] text-paper-2 hover:bg-paper-2 hover:text-ink disabled:cursor-not-allowed disabled:!bg-disabled disabled:!text-muted md:h-[52px] md:text-[13px]"
              >
                {savingAddress ? "SAVING…" : addressSaved ? "RESAVE ADDRESS" : "CONTINUE TO SHIPPING"}
              </button>
            </div>
          </div>

          {/* DELIVERY */}
          <div>
            <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
              DELIVERY
            </h2>
            {!addressSaved ? (
              <p className="font-mono text-[12px] text-muted">
                Save a shipping address to get rates.
              </p>
            ) : fetchingQuotes ? (
              <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
                FETCHING RATES…
              </p>
            ) : quotesError ? (
              <div className="flex flex-col gap-3">
                <p className="font-mono text-[12px] text-muted">{quotesError}</p>
                <button
                  type="button"
                  onClick={() => void loadQuotes()}
                  className="w-fit cursor-pointer border border-ink bg-transparent px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink hover:bg-ink hover:text-paper-2"
                >
                  GET RATES
                </button>
              </div>
            ) : (shippingQuotes ?? []).length === 0 ? (
              <div className="flex flex-col gap-3">
                <p className="font-mono text-[12px] text-muted">
                  No shipping rates returned.
                </p>
                <button
                  type="button"
                  onClick={() => void loadQuotes()}
                  className="w-fit cursor-pointer border border-ink bg-transparent px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink hover:bg-ink hover:text-paper-2"
                >
                  GET RATES
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {(shippingQuotes ?? []).map((quote) => {
                  const isSelected = selectedShipping?.quoteId === quote.id;
                  return (
                    <button
                      key={quote.id}
                      type="button"
                      onClick={() => void handleSelectOption(quote.id ?? "")}
                      disabled={selectingOption || syncing}
                      className={`flex cursor-pointer items-center justify-between border border-ink px-4 py-3 text-left ${
                        isSelected ? "bg-ink text-paper" : "bg-transparent"
                      }`}
                    >
                      <div>
                        <div className="font-mono text-[12px] uppercase">
                          {(quote.serviceLevel ?? "SHIPPING").toUpperCase()}
                        </div>
                        <div
                          className={`font-mono text-[10px] ${
                            isSelected ? "text-paper/70" : "text-muted"
                          }`}
                        >
                          {quote.etaDays != null
                            ? `${quote.etaDays} business day${quote.etaDays === 1 ? "" : "s"}`
                            : "Delivery estimate"}
                        </div>
                      </div>
                      <div className="font-mono text-[12px]">
                        {quote.amountMinor != null
                          ? format(quote.amountMinor, quote.currency ?? subtotalCurrency)
                          : "—"}
                      </div>
                    </button>
                  );
                })}
                {selectedShipping && (
                  <div className="mt-1 font-mono text-[10px] tracking-[0.04em] text-muted">
                    SHIPPING AMOUNT FROZEN BY STORE.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* PAYMENT */}
          <div>
            <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
              PAYMENT
            </h2>
            <div className="border border-ink px-4 py-3">
              <div className="font-mono text-[12px] uppercase">PAYSTACK</div>
              <div className="mt-0.5 font-mono text-[10px] text-muted">
                Pay with card, bank, USSD, or transfer. You&apos;ll be taken to
                the secure gateway — the store confirms your payment
                automatically.
              </div>
            </div>
            {paymentError && (
              <div className="mt-3 border border-ink bg-paper px-4 py-3 font-mono text-[11px] tracking-[0.04em] text-ink">
                {paymentError}
              </div>
            )}
          </div>

          {/* SUBMIT BUTTON */}
          <button
            type="button"
            onClick={() => void handlePlaceOrder()}
            disabled={!canPlaceOrder}
            className="h-14 w-full bg-ink font-mono text-[13px] uppercase tracking-[0.1em] text-paper-2 hover:bg-paper-2 hover:text-ink hover:shadow-[inset_0_0_0_1px_theme(colors.ink)] disabled:cursor-not-allowed disabled:!bg-disabled disabled:!text-muted"
          >
            {initializingPayment
              ? "STARTING PAYMENT…"
              : selectedShipping
                ? "CONTINUE TO PAYMENT"
                : "SELECT A SHIPPING OPTION"}
          </button>
          {!canPlaceOrder && !initializingPayment && readiness.reason && (
            <p className="mt-2 text-center font-mono text-[10px] tracking-[0.04em] text-muted">
              {readiness.reason}
            </p>
          )}
        </form>

        {/* RIGHT: order summary — DESKTOP ONLY */}
        <aside className="hidden md:block">
          <div className="sticky top-24">
            <OrderSummary
              lines={lines}
              subtotalAmount={subtotalAmount}
              taxAmountMinor={taxAmountMinor}
              shippingAmountMinor={shippingAmountMinor}
              totalAmountMinor={totalAmountMinor}
              currency={subtotalCurrency}
              appliedPromotion={appliedPromotion}
              onApplyDiscount={handleApplyDiscount}
              discountError={discountError}
              shippingLabel={shippingLabel}
            />
          </div>
        </aside>
      </div>
    </section>
  );
}