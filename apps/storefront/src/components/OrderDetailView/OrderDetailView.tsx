// apps/storefront/src/components/OrderDetailView/OrderDetailView.tsx
//
// Single-order view from `GET /store/orders/{id}` (bearer → backend enforces
// customer ownership). Renders ONLY the public OpenAPI `Order` projection: the
// frozen money fields (subtotalMinor / discountMinor / taxMinor /
// shippingMinor / insuranceMinor / totalAmountMinor), line items, statuses, and
// the public `Fulfillment` projection (id, trackingNumber, courier, labelUrl,
// serviceLevel, status, createdAt). Provider-internal fulfillment fields
// (providerShipmentId, requestToken, sourcingLocationId, ...) are never
// consumed — they are not part of the HTTP contract. Money is always the
// server value; the frontend only formats it.
//
// Slice 2B reliability rules:
//   G009 — the authentication state is resolved BEFORE the bearer-protected
//          order request is made (resolveOrderFetchGate): known guests get the
//          sign-in state and the protected order is NEVER fetched for them;
//          while identity resolution is in flight no request fires either.
//   G008 — while the page is open and the fulfillment lifecycle is still
//          mutable, the projection refreshes on a slow LOCAL interval
//          (orderPolling.ts); polling stops for good at a terminal state,
//          survives transient network failures (the last good projection
//          stays visible), and is torn down on unmount. No global polling
//          framework — this view owns its single timer.
//   G033 — the public Order projection exposes NO shipping-address data
//          (verified against openapi.yaml: only Cart/DraftOrder schemas carry
//          shippingAddress), so nothing address-related is rendered here and
//          NO extra API request is made to compensate.

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useCurrency } from "@/context/CurrencyContext";
import { getOrder } from "@/lib/api/orders";
import { isApiError, normalizeApiError } from "@/lib/api/errors";
import type { AsyncState } from "@/lib/async";
import { resolveOrderFetchGate } from "@/lib/orderAccess";
import {
  ORDER_POLL_INTERVAL_MS,
  shouldPollOrder,
} from "@/lib/orderPolling";
import {
  lineFulfillmentLabel,
  receiptSummaryRows,
  receiptTotalRow,
} from "@/lib/receiptRows";
import AsyncStateView from "@/components/AsyncState/AsyncState";
import type { Fulfillment, Order, OrderLineItem } from "@/lib/types";

export default function OrderDetailView({ orderId }: { orderId: string }) {
  const { status, openAuth } = useAuth();
  const { format } = useCurrency();

  // G009: decide from the identity FIRST; the fetcher below only runs when
  // the gate says "fetch".
  const gate = resolveOrderFetchGate(status);

  const [state, setState] = useState<AsyncState<Order>>({ status: "loading" });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // Initial (and retry) load — gated on the resolved identity.
  useEffect(() => {
    if (gate !== "fetch") return;
    let cancelled = false;
    getOrder(orderId).then(
      (data) => {
        if (!cancelled) setState({ status: "success", data });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            error: isApiError(error) ? error : normalizeApiError(error),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [orderId, gate, version]);

  // G008: slow local refresh while the fulfillment lifecycle is mutable.
  // Transient failures keep the last good projection on screen and do NOT
  // stop the loop; a terminal state stops it permanently; unmount clears it.
  useEffect(() => {
    if (gate !== "fetch") return;
    if (state.status !== "success" || !shouldPollOrder(state.data)) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getOrder(orderId).then(
        (next) => {
          if (!cancelled) setState({ status: "success", data: next });
        },
        () => {
          // Transient network/API failure: keep polling, keep showing the
          // last authoritative projection. Nothing is fabricated.
        },
      );
    }, ORDER_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [gate, orderId, state]);

  if (status === "loading" || gate === "wait") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
          LOADING ORDER…
        </span>
      </div>
    );
  }

  if (gate === "signin") {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 px-4 text-center md:px-8">
        <div className="font-mono text-[11px] tracking-[0.1em] text-muted md:text-[12px]">
          [ SIGN IN REQUIRED ]
        </div>
        <h1 className="m-0 font-display text-[clamp(32px,7vw,72px)] font-black uppercase leading-[0.95]">
          SIGN IN TO SEE YOUR ORDER.
        </h1>
        <button
          type="button"
          onClick={openAuth}
          className="cursor-pointer border border-ink bg-transparent px-6 py-3.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2 md:px-8 md:py-4 md:text-[12px]"
        >
          SIGN IN
        </button>
      </div>
    );
  }

  return (
    <section className="px-4 pb-14 pt-6 md:px-8 md:pb-24 md:pt-10">
      <div className="mb-2.5 font-mono text-[10px] tracking-[0.06em] text-muted md:mb-3 md:text-[12px] md:tracking-[0.08em]">
        HOME / ACCOUNT / ORDER
      </div>
      <h1 className="mb-6 mt-0 font-display text-[28px] font-bold uppercase md:mb-8 md:text-[44px]">
        ORDER
      </h1>

      {/* G033: the Order projection carries no shipping-address fields, so no
          address block is rendered and no additional request is issued. */}
      <AsyncStateView
        state={state}
        loadingLabel="LOADING ORDER…"
        emptyLabel="Order not found."
        onRetry={reload}
      >
        {(data) => <OrderDetail order={data} format={format} />}
      </AsyncStateView>

      <Link
        href="/account"
        className="mt-8 inline-block cursor-pointer border border-ink bg-transparent px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2"
      >
        ← BACK TO ACCOUNT
      </Link>
    </section>
  );
}

function OrderDetail({
  order,
  format,
}: {
  order: Order;
  format: (amount: number, currencyCode: string) => string;
}) {
  const currency = order.currency ?? "NGN";
  const created = order.createdAt
    ? new Date(order.createdAt).toLocaleDateString("en")
    : "";

  // F9/E6: rows come from the pure rule in lib/receiptRows.ts — server values
  // verbatim, no money math here. Deductions render their sign at display time.
  const moneyRows = receiptSummaryRows(order);
  const totalRow = receiptTotalRow(order);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4 border border-ink p-5 md:p-6">
        <div className="min-w-0 font-mono text-[11px] text-muted">
          <div className="break-all text-ink">{order.id}</div>
          <div className="mt-1.5 text-muted">
            {created || "—"} · {order.paymentStatus} / {order.fulfillmentStatus}
          </div>
          {order.transactionReference && (
            <div className="mt-1 text-muted">
              REF: {order.transactionReference}
            </div>
          )}
        </div>
        <div className="font-mono text-[16px] md:text-[18px]">
          {format(order.totalAmountMinor, currency)}
        </div>
      </div>

      <h2 className="mb-4 mt-10 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
        ITEMS
      </h2>
      <ul className="divide-y divide-[#e5e3df] border-t border-[#e5e3df]">
        {(order.lineItems ?? []).map((line) => (
          <OrderLineItemRow key={line.id} line={line} format={format} currency={currency} />
        ))}
      </ul>

      <h2 className="mb-4 mt-10 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
        SUMMARY
      </h2>
      <dl className="divide-y divide-[#e5e3df] border-t border-[#e5e3df] font-mono text-[12px]">
        {moneyRows.map((row) => (
          <div key={row.label} className="flex items-center justify-between py-2.5">
            <dt className="text-muted">{row.label}</dt>
            <dd>
              {row.kind === "deduction"
                ? `-${format(row.amountMinor, currency)}`
                : format(row.amountMinor, currency)}
            </dd>
          </div>
        ))}
        <div className="flex items-center justify-between py-2.5 font-semibold">
          <dt className="text-muted">{totalRow.label}</dt>
          <dd>{format(totalRow.amountMinor, currency)}</dd>
        </div>
      </dl>

      <h2 className="mb-4 mt-10 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
        FULFILLMENT
      </h2>
      {(order.fulfillments ?? []).length === 0 ? (
        <p className="font-mono text-[12px] text-muted">
          No shipment yet. Items are being prepared.
        </p>
      ) : (
        <ul className="divide-y divide-[#e5e3df] border-t border-[#e5e3df]">
          {(order.fulfillments ?? []).map((fulfillment) => (
            <FulfillmentRow key={fulfillment.id} fulfillment={fulfillment} />
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderLineItemRow({
  line,
  format,
  currency,
}: {
  line: OrderLineItem;
  format: (amount: number, currencyCode: string) => string;
  currency: string;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-4">
      <div className="min-w-0">
        <div className="font-mono text-[12px] text-ink">
          {line.quantity} × {format(line.unitPriceMinor, currency)}
        </div>
        <div className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-[0.05em] text-muted">
          VARIANT {line.variantId ?? "—"}
        </div>
      </div>
      <div className="font-mono text-[11px] text-muted">
        {lineFulfillmentLabel(line)}
      </div>
    </li>
  );
}

function FulfillmentRow({ fulfillment }: { fulfillment: Fulfillment }) {
  const shipped = fulfillment.createdAt
    ? new Date(fulfillment.createdAt).toLocaleDateString("en")
    : "";
  return (
    <li className="py-4 font-mono text-[12px] text-ink">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="uppercase tracking-[0.05em]">{fulfillment.status}</span>
        <span className="text-muted">{shipped || "—"}</span>
      </div>
      <div className="mt-1.5 text-muted">
        {[fulfillment.courier, fulfillment.serviceLevel]
          .filter(Boolean)
          .join(" · ") || "No carrier details yet."}
      </div>
      {fulfillment.trackingNumber && (
        <div className="mt-1 text-muted">
          TRACKING {fulfillment.trackingNumber}
          {fulfillment.labelUrl && (
            <>
              {" "}·{" "}
              <a
                href={fulfillment.labelUrl}
                target="_blank"
                rel="noreferrer"
                className="text-ink underline underline-offset-2 hover:opacity-60"
              >
                LABEL
              </a>
            </>
          )}
        </div>
      )}
    </li>
  );
}
