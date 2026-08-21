// apps/storefront/src/lib/format.ts
//
// Monetary display formatting.
//
// The API expresses every amount as an integer in MINOR units (kobo/cents) —
// see the OpenAPI convention "Money is always expressed as a non-negative
// integer in minor units". AMOUNT_IN_MINOR_UNITS must stay `true`: formatMoney
// merely divides by 100 for display. It never converts currencies, and every
// amount passed in is the server-authoritative `*Minor` value (the frontend
// never computes, derives, or invents money).

const AMOUNT_IN_MINOR_UNITS = true;

export function formatPrice(amount: number, currencyCode: string): string {
  const value = AMOUNT_IN_MINOR_UNITS ? amount / 100 : amount;

  // Intl.NumberFormat handles the right symbol + spacing per currency for free
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currencyCode.toUpperCase(),
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currencyCode.toUpperCase()} ${Math.round(value)}`;
  }
}