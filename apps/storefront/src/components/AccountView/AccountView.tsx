// apps/storefront/src/components/AccountView/AccountView.tsx
//
// Customer account view: profile from `GET /store/customers/me` (identity
// always from the authenticated session), address book from
// `GET/POST/PUT/DELETE /store/customers/me/addresses`, and order history from
// `GET /store/customers/me/orders` (paginated `{ items, total }`). All data
// states (loading / success / empty / error) render through the central
// AsyncStateView; the guest state is a prompt to open the auth drawer.
// No demo data and no silent fallbacks: API failures surface as the error state.
//
// G007 address editing: preload -> validate -> `PUT .../{id}` (204) ->
// authoritative refetch. The resulting server address is never fabricated
// locally. Default-address limitation: the contract has no book-wide
// "set default" endpoint (per-entry `isDefault` only), so editing preserves
// the entry's existing flag and offers no default toggle — see addressEdit.ts.

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useCurrency } from "@/context/CurrencyContext";
import { useToast } from "@/context/ToastContext";
import { DEFAULT_REGION_CURRENCY } from "@/lib/api/client";
import {
  createAddress,
  deleteAddress,
  getAddresses,
  getOrderHistory,
  updateAddress,
} from "@/lib/api/customers";
import { ApiError, isApiError, normalizeApiError } from "@/lib/api/errors";
import {
  addressToEditForm,
  editFormToAddressInput,
  firstInvalidField,
  validateAddressForm,
  type EditableAddressForm,
} from "@/lib/addressEdit";
import { resolveAccountDataGate } from "@/lib/authGates";
import { errorMessageOf } from "@/lib/errorPresentation";
import { useAsyncData } from "@/lib/async";
import AsyncStateView from "@/components/AsyncState/AsyncState";
import type { Address, AddressInput, Order } from "@/lib/types";

const ORDERS_PAGE_SIZE = 10;

export default function AccountView() {
  const { customer, status, error, logout, openAuth, reload } = useAuth();
  const { format } = useCurrency();
  const { showToast } = useToast();

  // ---------------------------------------------------------------------------
  // Order history: first page on load, LOAD MORE appends the next page
  // (deduplicated by id) until the server-reported total is reached.
  // F8: this effect is keyed on customerId — while identity is unresolved
  // (loading/guest) it is null and NO protected request fires.
  // ---------------------------------------------------------------------------
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [ordersTotal, setOrdersTotal] = useState(0);
  const [ordersStatus, setOrdersStatus] = useState<
    "loading" | "success" | "empty" | "error"
  >("loading");
  const [ordersError, setOrdersError] = useState<ApiError | null>(null);
  const [ordersVersion, setOrdersVersion] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const customerId = customer?.id ?? null;

  const applyOrderPage = useCallback((page: { items: Order[]; total: number }, append: boolean) => {
    setOrders((prev) => {
      if (!append || !prev) return page.items;
      const seen = new Set(prev.map((order) => order.id));
      return [...prev, ...page.items.filter((order) => !seen.has(order.id))];
    });
    setOrdersTotal(page.total);
  }, []);

  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    const first = async () => {
      setOrdersStatus("loading");
      try {
        const page = await getOrderHistory({ limit: ORDERS_PAGE_SIZE, offset: 0 });
        if (cancelled) return;
        applyOrderPage(page, false);
        setOrdersStatus(page.items.length === 0 ? "empty" : "success");
        setOrdersError(null);
      } catch (err) {
        if (cancelled) return;
        setOrdersError(isApiError(err) ? err : normalizeApiError(err));
        setOrdersStatus("error");
      }
    };
    void first();
    return () => {
      cancelled = true;
    };
  }, [customerId, ordersVersion, applyOrderPage]);

  const loadMoreOrders = useCallback(async () => {
    if (!orders) return;
    setLoadingMore(true);
    try {
      const page = await getOrderHistory({ limit: ORDERS_PAGE_SIZE, offset: orders.length });
      applyOrderPage(page, true);
    } catch (err) {
      showToast(errorMessageOf(err));
    } finally {
      setLoadingMore(false);
    }
  }, [orders, applyOrderPage, showToast]);

  // ---------------------------------------------------------------------------

  // F8: the identity gate is a PURE rule (lib/authGates). The data sections
  // below only MOUNT on "ready" — the address book lives in a child component
  // whose fetch effects cannot even exist while identity is unresolved, so a
  // known guest (or an in-flight resolution) can never trigger a protected
  // account request.
  const gate = resolveAccountDataGate(status);

  if (gate === "wait") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
          LOADING ACCOUNT…
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
          SIGN IN TO SEE YOUR ACCOUNT.
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

  if (gate === "identity-error") {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-5 px-4 text-center">
        <span className="font-mono text-[11px] tracking-[0.1em] text-muted">
          {error?.message ?? "Failed to load your account."}
        </span>
        <button
          type="button"
          onClick={() => void reload()}
          className="cursor-pointer border border-ink bg-transparent px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2"
        >
          TRY AGAIN
        </button>
      </div>
    );
  }

  const orderItems = orders ?? [];
  const hasMore = ordersTotal > orderItems.length;

  return (
    <section className="px-4 pb-14 pt-6 md:px-8 md:pb-24 md:pt-10">
      <div className="mb-2.5 font-mono text-[10px] tracking-[0.06em] text-muted md:mb-3 md:text-[12px] md:tracking-[0.08em]">
        HOME / ACCOUNT
      </div>
      <h1 className="mb-6 mt-0 font-display text-[28px] font-bold uppercase md:mb-8 md:text-[44px]">
        ACCOUNT
      </h1>

      <div className="mb-10 flex flex-wrap items-center justify-between gap-4 border border-ink p-5 md:p-6">
        <div>
          <div className="font-display text-[15px] font-semibold uppercase md:text-[17px]">
            {customer?.firstName} {customer?.lastName}
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted md:text-[12px]">
            {customer?.email}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void logout()}
          className="cursor-pointer border border-ink bg-transparent px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink hover:bg-ink hover:text-paper-2"
        >
          SIGN OUT
        </button>
      </div>

      {/* F8: mounted ONLY on an authenticated identity — its fetch effects
          cannot run for a guest or while resolution is in flight. */}
      <AddressBookSection />

      <h2 className="mb-4 mt-10 font-mono text-[11px] uppercase tracking-[0.1em] text-muted md:mb-6">
        ORDER HISTORY
      </h2>
      {ordersStatus === "loading" && (
        <div className="flex min-h-[20vh] items-center justify-center px-4">
          <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
            LOADING ORDERS…
          </span>
        </div>
      )}
      {ordersStatus === "error" && (
        <div className="flex min-h-[20vh] flex-col items-center justify-center gap-5 px-4 text-center">
          <span className="font-mono text-[11px] tracking-[0.1em] text-muted">
            {ordersError?.message ?? "Failed to load orders."}
          </span>
          <button
            type="button"
            onClick={() => setOrdersVersion((v) => v + 1)}
            className="cursor-pointer border border-ink bg-transparent px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2"
          >
            TRY AGAIN
          </button>
        </div>
      )}
      {ordersStatus === "empty" && (
        <p className="font-mono text-[12px] text-muted">No orders yet.</p>
      )}
      {ordersStatus === "success" && orderItems.length > 0 && (
        <>
          <ul className="divide-y divide-[#e5e3df] border-t border-[#e5e3df]">
            {orderItems.map((order) => (
              <li key={order.id} className="py-4">
                <Link
                  href={`/account/orders/${order.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 hover:opacity-60"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11px] text-muted">
                      {order.id}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.05em] text-muted">
                      {order.paymentStatus} / {order.fulfillmentStatus}
                    </div>
                  </div>
                  <div className="font-mono text-[12px]">
                    {format(
                      order.totalAmountMinor,
                      order.currency ?? DEFAULT_REGION_CURRENCY,
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {hasMore && (
            <button
              type="button"
              onClick={() => void loadMoreOrders()}
              disabled={loadingMore}
              className="mt-5 cursor-pointer border border-ink bg-transparent px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2 disabled:cursor-default disabled:opacity-50"
            >
              {loadingMore ? "LOADING…" : "LOAD MORE"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

// F8: the entire address book (list + add/edit/remove) lives in this child so
// its useAsyncData fetch effect only exists while the parent has mounted it —
// i.e. ONLY on a resolved, authenticated identity. A known guest visiting
// /account can therefore never trigger GET /store/customers/me/addresses.
// G007 edit flow unchanged: preload -> validate -> PUT -> authoritative
// refetch; no book-wide default operation exists or is offered.
function AddressBookSection() {
  const { showToast } = useToast();

  const addresses = useAsyncData(() => getAddresses(), []);
  const [addingAddress, setAddingAddress] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const onSaveAddress = useCallback(
    async (addressId: string, input: AddressInput): Promise<void> => {
      setSavingId(addressId);
      try {
        await updateAddress(addressId, input);
        await addresses.reload();
        setEditingId(null);
        showToast("Address updated.");
      } finally {
        setSavingId(null);
      }
    },
    [addresses, showToast],
  );

  // F9 — creation lifecycle contract: resolves ONLY after the server accepted
  // the address AND the authoritative refetch completed; rejects on failure so
  // AddAddressForm can keep the entered data and show the error inline. The
  // form never clears on an unconfirmed attempt.
  const onAddAddress = useCallback(
    async (input: AddressInput) => {
      setAddingAddress(true);
      try {
        await createAddress(input);
        await addresses.reload();
        showToast("Address added.");
      } finally {
        setAddingAddress(false);
      }
    },
    [addresses, showToast],
  );

  const onRemoveAddress = useCallback(
    async (addressId: string) => {
      setRemovingId(addressId);
      try {
        await deleteAddress(addressId);
        addresses.reload();
        showToast("Address removed.");
      } catch (err) {
        showToast(
          errorMessageOf(err),
        );
      } finally {
        setRemovingId(null);
      }
    },
    [addresses, showToast],
  );

  return (
    <div>
      <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.1em] text-muted md:mb-6">
        ADDRESSES
      </h2>
      <AsyncStateView
        state={addresses.state}
        loadingLabel="LOADING ADDRESSES…"
        emptyLabel="No addresses yet."
        onRetry={addresses.reload}
      >
        {(data) => (
          <ul className="grid gap-3 md:grid-cols-2">
            {data.map((address) =>
              editingId === address.id ? (
                <li key={address.id} className="border border-ink p-4">
                  <EditAddressForm
                    address={address}
                    busy={savingId === address.id}
                    onCancel={() => setEditingId(null)}
                    onSave={(input) => onSaveAddress(address.id, input)}
                  />
                </li>
              ) : (
                <AddressCard
                  key={address.id}
                  address={address}
                  removing={removingId === address.id}
                  onRemove={() => void onRemoveAddress(address.id)}
                  onEdit={() => setEditingId(address.id)}
                />
              ),
            )}
          </ul>
        )}
      </AsyncStateView>
      <AddAddressForm busy={addingAddress} onAdd={onAddAddress} />
    </div>
  );
}

function AddressCard({
  address,
  removing,
  onRemove,
  onEdit,
}: {
  address: Address;
  removing: boolean;
  onRemove: () => void;
  onEdit: () => void;
}) {
  const name = [address.firstName, address.lastName].filter(Boolean).join(" ");
  const region = [address.city, address.state, address.postalCode]
    .filter(Boolean)
    .join(", ");
  return (
    <li className="flex items-start justify-between gap-3 border border-[#e5e3df] p-4">
      <div className="min-w-0 font-mono text-[12px] text-ink">
        {address.isDefault && (
          <span className="mr-2 inline-block bg-ink px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-paper-2">
            DEFAULT
          </span>
        )}
        {name && <div className="font-semibold">{name}</div>}
        {address.line1 && <div>{address.line1}</div>}
        {address.line2 && <div>{address.line2}</div>}
        {region && <div>{region}</div>}
        {address.countryCode && <div>{address.countryCode}</div>}
        {address.phone && <div className="text-muted">{address.phone}</div>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <button
          type="button"
          onClick={onEdit}
          disabled={removing}
          className="cursor-pointer border-none bg-transparent font-mono text-[10px] uppercase tracking-[0.08em] text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-default disabled:opacity-50"
        >
          EDIT
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          className="cursor-pointer border-none bg-transparent font-mono text-[10px] uppercase tracking-[0.08em] text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-default disabled:opacity-50"
        >
          {removing ? "REMOVING…" : "REMOVE"}
        </button>
      </div>
    </li>
  );
}

function EditAddressForm({
  address,
  busy,
  onCancel,
  onSave,
}: {
  address: Address;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: AddressInput) => Promise<void>;
}) {
  // Preload the EXISTING server address once per edit session; later refetches
  // never clobber in-progress edits.
  const [form, setForm] = useState<EditableAddressForm>(() =>
    addressToEditForm(address),
  );
  const [errors, setErrors] = useState<
    Partial<Record<keyof EditableAddressForm, string>>
  >({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setField = (field: keyof EditableAddressForm, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || busy) return;
    const validation = validateAddressForm(form);
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      return;
    }
    setErrors({});
    setError(null);
    setSubmitting(true);
    try {
      // Whitelisted AddressInput only; `isDefault` preserved from the server
      // record (no book-wide default endpoint exists — see addressEdit.ts).
      await onSave(editFormToAddressInput(form, address));
      // Success path (refetch + toast + close) is owned by the parent.
    } catch (err) {
      setError(errorMessageOf(err));
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass =
    "min-w-0 border border-[#e5e3df] bg-transparent px-3 py-2 font-mono text-[12px] text-ink outline-none placeholder:text-muted focus:border-ink";
  const pending = submitting || busy;

  return (
    <form onSubmit={submit} className="grid grid-cols-2 gap-3 md:grid-cols-3">
      <div className="col-span-2 mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-muted md:col-span-3">
        EDIT ADDRESS
      </div>
      {(
        [
          ["firstName", "FIRST NAME *"],
          ["lastName", "LAST NAME *"],
          ["phone", "PHONE *"],
          ["line1", "LINE 1 *"],
          ["line2", "LINE 2"],
          ["city", "CITY *"],
          ["state", "STATE *"],
          ["postalCode", "POSTAL CODE *"],
          ["countryCode", "COUNTRY CODE *"],
        ] as Array<[keyof EditableAddressForm, string]>
      ).map(([field, placeholder]) => (
        <div key={field} className="flex flex-col gap-1">
          <input
            value={form[field]}
            onChange={(e) => setField(field, e.target.value)}
            aria-label={placeholder.replace(" *", "")}
            placeholder={placeholder}
            maxLength={field === "countryCode" ? 2 : undefined}
            className={`${inputClass} ${errors[field] ? "border-ink" : ""}`}
          />
          {errors[field] && (
            <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-ink">
              {errors[field]}
            </span>
          )}
        </div>
      ))}

      {error && (
        <div className="col-span-2 border border-ink bg-paper px-3 py-2 font-mono text-[11px] tracking-[0.04em] text-ink md:col-span-3">
          {error}
        </div>
      )}

      <div className="col-span-2 flex gap-3 md:col-span-3">
        <button
          type="submit"
          disabled={pending}
          className="cursor-pointer border border-ink bg-ink px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-paper-2 disabled:cursor-default disabled:opacity-50"
        >
          {pending ? "SAVING…" : "SAVE CHANGES"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="cursor-pointer border border-ink bg-transparent px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2 disabled:cursor-default disabled:opacity-50"
        >
          CANCEL
        </button>
      </div>
    </form>
  );
}

// F9 — creation lifecycle (Strict Mode safe): submit → submitting → server
// request → success → authoritative refresh (owned by the parent) → clear and
// close. The form stays in its submitting state until the parent's promise
// settles; on failure the entered data is PRESERVED and the error renders
// inline. The mounted ref makes the late async settlement a no-op after
// unmount (no state writes into a dead component, no timer scheduling).
//
// F10 — validation UX without a second validation engine: the SAME pure
// rules as the edit form (lib/addressEdit.ts — required-field + whitespace
// detection only) block obvious empty submissions; per-field errors are
// aria-associated and the first invalid field is focused. NO postcode,
// country or state rules are invented and values are not normalized beyond
// the shared whitelisted payload builder.
const ADD_ADDRESS_FIELDS: Array<{
  field: keyof EditableAddressForm;
  label: string;
}> = [
  { field: "firstName", label: "FIRST NAME" },
  { field: "lastName", label: "LAST NAME" },
  { field: "phone", label: "PHONE" },
  { field: "line1", label: "LINE 1" },
  { field: "line2", label: "LINE 2" },
  { field: "city", label: "CITY" },
  { field: "state", label: "STATE" },
  { field: "postalCode", label: "POSTAL CODE" },
  { field: "countryCode", label: "COUNTRY CODE" },
];
const addAddressFieldId = (field: keyof EditableAddressForm): string =>
  `add-address-${field}`;

function AddAddressForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (input: AddressInput) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<EditableAddressForm>(() => ({
    firstName: "",
    lastName: "",
    phone: "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    postalCode: "",
    countryCode: "NG",
  }));
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof EditableAddressForm, string>>
  >({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setField = (field: keyof EditableAddressForm, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    // Editing a field clears its own validation message.
    setFieldErrors((prev) =>
      prev[field] ? { ...prev, [field]: undefined } : prev,
    );
  };

  const resetFields = () => {
    setForm({
      firstName: "",
      lastName: "",
      phone: "",
      line1: "",
      line2: "",
      city: "",
      state: "",
      postalCode: "",
      countryCode: "NG",
    });
    setFieldErrors({});
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || busy) return;
    // Shared required-field rule — no invented format checks.
    const validation = validateAddressForm(form);
    const firstInvalid = firstInvalidField(validation);
    if (firstInvalid !== null) {
      setFieldErrors(validation);
      document.getElementById(addAddressFieldId(firstInvalid))?.focus();
      return;
    }
    setFieldErrors({});
    setError(null);
    setSubmitting(true);
    try {
      // Same whitelisted AddressInput mapping as the edit form; isDefault is
      // false because a NEW entry never starts as the default.
      // Resolves only after create + authoritative refresh succeeded.
      await onAdd(editFormToAddressInput(form, { isDefault: false }));
      if (!mountedRef.current) return;
      setOpen(false);
      resetFields();
    } catch (err) {
      // Failure keeps EVERY entered value on screen with the reason.
      if (!mountedRef.current) return;
      setError(errorMessageOf(err));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 cursor-pointer border border-ink bg-transparent px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2"
      >
        ADD ADDRESS
      </button>
    );
  }

  const inputClass =
    "min-w-0 border border-[#e5e3df] bg-transparent px-3 py-2 font-mono text-[12px] text-ink outline-none placeholder:text-muted focus:border-ink";
  const pending = submitting || busy;

  return (
    <form
      onSubmit={submit}
      noValidate
      className="mt-4 grid max-w-xl grid-cols-2 gap-3 border border-[#e5e3df] p-4 md:grid-cols-3"
    >
      {ADD_ADDRESS_FIELDS.map(({ field, label }) => {
        const id = addAddressFieldId(field);
        const hasError = Boolean(fieldErrors[field]);
        const errorId = `${id}-error`;
        return (
          <div key={field} className="flex flex-col gap-1">
            <input
              id={id}
              value={form[field]}
              onChange={(e) => setField(field, e.target.value)}
              aria-label={label}
              placeholder={`${label}${field === "line2" ? "" : " *"}`}
              maxLength={field === "countryCode" ? 2 : undefined}
              aria-invalid={hasError || undefined}
              aria-describedby={hasError ? errorId : undefined}
              className={inputClass}
            />
            {hasError && (
              <span
                id={errorId}
                role="alert"
                className="font-mono text-[9px] uppercase tracking-[0.06em] text-ink"
              >
                {fieldErrors[field]}
              </span>
            )}
          </div>
        );
      })}

      {error && (
        <div
          role="alert"
          className="col-span-2 border border-ink bg-paper px-3 py-2 font-mono text-[11px] tracking-[0.04em] text-ink md:col-span-3"
        >
          {error}
        </div>
      )}

      <div className="col-span-2 flex gap-3 md:col-span-3">
        <button
          type="submit"
          disabled={pending}
          className="cursor-pointer border border-ink bg-ink px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-paper-2 disabled:cursor-default disabled:opacity-50"
        >
          {pending ? "SAVING…" : "SAVE ADDRESS"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="cursor-pointer border border-ink bg-transparent px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2 disabled:cursor-default disabled:opacity-50"
        >
          CANCEL
        </button>
      </div>
    </form>
  );
}