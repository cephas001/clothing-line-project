// apps/api/tests/unit/notifications/MoneyFormatting.test.ts
//
// UNIT TESTS — L8 template money formatting (money.ts).
//
// Financial templates must NEVER perform floating-point arithmetic. This suite
// proves `formatMoneyMinor`:
//   - formats integer minor units with pure integer math (major/100, minor%100)
//     — e.g. 6_100_000 minor "ngn" -> "₦61,000.00";
//   - renders the AUTHORITATIVE currency symbol from the DTO's currency code
//     (a null/unknown currency renders amount-only, never a wrong symbol);
//   - throws on negative or non-safe-integer amounts (a corrupt value can never
//     silently reach an email body as a bogus figure).

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { formatMoneyMinor } from "@api/infrastructure/services/notifications/templates/money";

function expectThrows(fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
}

describe("formatMoneyMinor — safe integer minor-unit money formatting", () => {
  it("formats 6_100_000 minor naira as ₦61,000.00 (no floating-point math)", () => {
    expect(formatMoneyMinor(6_100_000, "ngn")).toBe("\u20a661,000.00");
  });

  it("formats 61_000 minor as ₦610.00", () => {
    expect(formatMoneyMinor(61000, "ngn")).toBe("\u20a6610.00");
  });

  it("formats 2_500 minor as ₦25.00 with the authoritative currency symbol", () => {
    expect(formatMoneyMinor(2500, "ngn")).toBe("\u20a625.00");
  });

  it("formats 500 minor dollars as $5.00", () => {
    expect(formatMoneyMinor(500, "usd")).toBe("$5.00");
  });

  it("renders a zero amount as ₦0.00 (never negative, never blank)", () => {
    expect(formatMoneyMinor(0, "ngn")).toBe("\u20a60.00");
  });

  it("renders a NULL/unknown currency amount-only (never invents a symbol)", () => {
    expect(formatMoneyMinor(61000, null)).toBe("610.00");
    expect(formatMoneyMinor(61000, "xft")).toBe("610.00");
  });

  it("is case-insensitive on the currency code (ngn / NGN / Ngn)", () => {
    const a = formatMoneyMinor(61000, "ngn");
    expect(formatMoneyMinor(61000, "NGN")).toBe(a);
    expect(formatMoneyMinor(61000, "Ngn")).toBe(a);
  });

  it("throws on a negative amount (a corrupt value never reaches an email body)", () => {
    expectThrows(() => formatMoneyMinor(-1, "ngn"));
  });

  it("throws on a fractional (non-integer) amount — no float rounding", () => {
    expectThrows(() => formatMoneyMinor(61_000.5, "ngn"));
  });
});