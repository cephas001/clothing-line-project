// apps/storefront/tests/unit/catalogFidelity.test.ts
//
// F7.1 catalog-fidelity rules (src/lib/availability.ts):
//   - G016: variants classify into exactly three truthful states
//     (in_stock / backorder / out_of_stock); backorder is orderable but is
//     NEVER presented as physically in stock.
//   - G017: a live VariantAvailability merges without inventing stock or
//     prices, and the latest-wins guard discards stale responses so an older
//     fetch can never overwrite a newer selection.
//   - G015 support: merged views keep the flags the PDP busy state relies on.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  availabilityOf,
  createLatestWinsGuard,
  isSelectable,
  mergeAvailability,
} from "../../src/lib/availability";
import { makeProduct, makeVariant } from "../helpers/fixtures";
import { toProductView } from "../../src/lib/product";

describe("availabilityOf (G016 truth table)", () => {
  it("classifies positive inventory as in_stock", () => {
    expect(
      availabilityOf({ inventoryQuantity: 3, allowBackorder: false }),
    ).toBe("in_stock");
    expect(
      availabilityOf({ inventoryQuantity: 1, allowBackorder: true }),
    ).toBe("in_stock");
  });

  it("classifies zero stock with backorder as backorder — NOT in stock", () => {
    expect(
      availabilityOf({ inventoryQuantity: 0, allowBackorder: true }),
    ).toBe("backorder");
  });

  it("classifies zero stock without backorder as out_of_stock", () => {
    expect(
      availabilityOf({ inventoryQuantity: 0, allowBackorder: false }),
    ).toBe("out_of_stock");
  });
});

describe("isSelectable (G016 orderability)", () => {
  it("in-stock and backorder variants are selectable; out-of-stock is not", () => {
    expect(isSelectable("in_stock")).toBe(true);
    expect(isSelectable("backorder")).toBe(true);
    expect(isSelectable("out_of_stock")).toBe(false);
  });
});

describe("mergeAvailability (G017 live availability)", () => {
  it("overwrites quantity and backorder flag with fresh server values", () => {
    const view = toProductView(
      makeProduct({ variants: [makeVariant({ id: "v1", inventoryQuantity: 5 })] }),
    );
    const merged = mergeAvailability(view, {
      variantId: "v1",
      inventoryQuantity: 0,
      allowBackorder: true,
      priceMinor: null,
    });
    expect(merged.variants[0].inventoryQuantity).toBe(0);
    expect(merged.variants[0].allowBackorder).toBe(true);
    expect(merged.variants[0].available).toBe(true);
    // The product-level sold-out projection is recomputed truthfully.
    expect(merged.isSoldOut).toBe(false);
  });

  it("marks the product sold out when the live check says nothing is orderable", () => {
    const view = toProductView(
      makeProduct({
        variants: [
          makeVariant({ id: "v1", inventoryQuantity: 2 }),
          makeVariant({ id: "v2", inventoryQuantity: 3 }),
        ],
      }),
    );
    const step1 = mergeAvailability(view, {
      variantId: "v1",
      inventoryQuantity: 0,
      allowBackorder: false,
      priceMinor: null,
    });
    expect(step1.isSoldOut).toBe(false);
    const step2 = mergeAvailability(step1, {
      variantId: "v2",
      inventoryQuantity: 0,
      allowBackorder: false,
      priceMinor: null,
    });
    expect(step2.isSoldOut).toBe(true);
  });

  it("updates priceMinor only when the server provides one (null keeps the authoritative display price)", () => {
    const view = toProductView(
      makeProduct({ variants: [makeVariant({ id: "v1", priceMinor: 15000 })] }),
    );
    const updated = mergeAvailability(view, {
      variantId: "v1",
      inventoryQuantity: 5,
      allowBackorder: false,
      priceMinor: 17500,
    });
    expect(updated.variants[0].priceMinor).toBe(17500);

    const kept = mergeAvailability(view, {
      variantId: "v1",
      inventoryQuantity: 5,
      allowBackorder: false,
      priceMinor: null,
    });
    expect(kept.variants[0].priceMinor).toBe(15000);
  });

  it("returns the SAME reference when nothing changed (no render loops)", () => {
    const view = toProductView(
      makeProduct({
        variants: [makeVariant({ id: "v1", inventoryQuantity: 5, priceMinor: 15000 })],
      }),
    );
    const same = mergeAvailability(view, {
      variantId: "v1",
      inventoryQuantity: 5,
      allowBackorder: false,
      priceMinor: 15000,
    });
    expect(same).toBe(view);
  });

  it("ignores availability for an unknown variant id", () => {
    const view = toProductView(makeProduct());
    const same = mergeAvailability(view, {
      variantId: "no-such-variant",
      inventoryQuantity: 99,
      allowBackorder: true,
      priceMinor: 1,
    });
    expect(same).toBe(view);
  });
});

describe("createLatestWinsGuard (G017 stale-response prevention)", () => {
  it("keeps only the newest ticket active", () => {
    const guard = createLatestWinsGuard();
    const first = guard.start();
    expect(guard.isActive(first)).toBe(true);

    const second = guard.start();
    expect(guard.isActive(second)).toBe(true);
    // The older response's ticket was invalidated by the newer start.
    expect(guard.isActive(first)).toBe(false);
  });

  it("never reactivates an old ticket and keeps counting monotonically", () => {
    const guard = createLatestWinsGuard();
    const a = guard.start();
    const b = guard.start();
    const c = guard.start();
    expect(guard.isActive(a)).toBe(false);
    expect(guard.isActive(b)).toBe(false);
    expect(guard.isActive(c)).toBe(true);
    expect(c).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(a);
  });

  it("simulated race: a slow older response loses to a newer selection", () => {
    const guard = createLatestWinsGuard();
    // User selects variant A -> fetch starts.
    const ticketA = guard.start();
    // User switches to variant B before A resolves -> new fetch starts.
    const ticketB = guard.start();
    // A resolves late: its ticket is stale, so its data must be discarded.
    expect(guard.isActive(ticketA)).toBe(false);
    // B resolves: applied.
    expect(guard.isActive(ticketB)).toBe(true);
  });
});
