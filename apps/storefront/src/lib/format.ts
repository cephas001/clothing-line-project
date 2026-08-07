// This might be changed later on 
// Verify if on the backend the Major units is 1 to ₦1 or Minor units (100 = ₦1)

const AMOUNT_IN_MINOR_UNITS = false;

export function formatPrice(amount: number, currencyCode: string): string {
    const value = AMOUNT_IN_MINOR_UNITS ? amount / 100 : amount;

  // Intl.NumberFormat handles the right symbol + spacing per currency for free
  // (₦, $, €…). The API sends lowercase codes, and Intl wants uppercase.
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