// apps/api/src/infrastructure/services/notifications/templates/money.ts

// Safe minor-unit money formatting for email templates.
//
// Templates NEVER do floating-point arithmetic. `amountMinor` is an integer in
// the currency's minor units (Kobo/cents) and is converted to a display string
// with pure integer math (major = amount / 100, minor = amount % 100). The
// currency code is AUTHORITATIVE — it comes verbatim from the producer-neutral
// DTO (a frozen order/payment/refund/quote record), never from today's pricing
// or a webhook.

const CURRENCY_SYMBOLS: Record<string, string> = {
  ngn: "\u20a6", // ₦
  usd: "$",
  gbp: "\u00a3", // £
  eur: "\u20ac", // €
  ghs: "\u20b5", // ₵
  kes: "KSh ",
  zar: "R ",
  ugx: "USh ",
  gbp2: "\u00a3", // £ (alias guard)
};

/** A non-negative, safe-integer amount in the currency's minor units. */
function assertValidMinorAmount(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error(
      `Cannot format a non-integer or negative amount in minor units: received ${String(amountMinor)}.`,
    );
  }
}

/**
 * Format a minor-unit amount into a human-readable string, e.g.
 * `(6100000, "ngn")` -> "₦61,000.00". The value is never mutated and no
 * floating-point division is performed. A null/unknown currency renders with
 * no symbol (amount only).
 */
export function formatMoneyMinor(
  amountMinor: number,
  currency: string | null | undefined,
): string {
  assertValidMinorAmount(amountMinor);

  const major = Math.floor(amountMinor / 100);
  const minor = amountMinor % 100;
  const minorString = minor.toString().padStart(2, "0");
  // Integer-only thousands separators — safe, locale-independent.
  const majorString = major
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  const symbol = currency
    ? (CURRENCY_SYMBOLS[currency.toLowerCase()] ?? "")
    : "";
  return `${symbol}${majorString}.${minorString}`;
}