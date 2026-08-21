// apps/storefront/tests/unit/format.test.ts
//
// Money display formatting. The core invariant: the API expresses amounts in
// MINOR units and the frontend NEVER converts or recomputes — formatPrice only
// divides by 100 for display and always receives the server-authoritative
// `*Minor` value.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { formatPrice } from "../../src/lib/format";

describe("formatPrice (minor-units display only)", () => {
  it("divides minor units by 100 for display", () => {
    const out = formatPrice(15000, "NGN");
    expect(out).toBeTruthy();
    expect(out).toContain("150");
    expect(out).not.toContain("1,5000");
  });

  it("never multiplies or converts the value", () => {
    const out = formatPrice(1000, "NGN");
    expect(out).toContain("10");
    expect(out).not.toContain("1,000");
  });

  it("formats zero", () => {
    expect(formatPrice(0, "NGN")).toContain("0");
  });

  it("falls back to a plain code+value string for unknown currency codes", () => {
    const out = formatPrice(500, "XYZ");
    expect(out).toContain("XYZ");
    expect(out).toContain("5");
  });

  it("uppercases the currency code passed through", () => {
    const out = formatPrice(200, "ngn");
    expect(out).not.toContain("ngn");
  });
});