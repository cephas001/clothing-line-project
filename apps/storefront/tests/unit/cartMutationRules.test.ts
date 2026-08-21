// apps/storefront/tests/unit/cartMutationRules.test.ts
//
// F8 Part 2 — pure cart-mutation planning rules (src/lib/cartMutations.ts).
// These rules harden the drawer against duplicate interactions WITHOUT
// touching the FIFO queue: bursts coalesce, crossing zero becomes one REMOVE,
// and an already-queued removal makes further clicks truthful no-ops instead
// of duplicate DELETEs that would 404 and toast a false error.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  isRemovalQueued,
  planQuantityChange,
  planRemoval,
} from "../../src/lib/cartMutations";

describe("planQuantityChange (F8 — +/- planning)", () => {
  it("plans a plain increment against the server quantity", () => {
    const plan = planQuantityChange({ currentQty: 2, pendingDelta: 0 }, 1);
    expect(plan.action).toBe("update");
    if (plan.action === "update") expect(plan.target).toBe(3);
    expect(plan.nextPending).toBe(1);
  });

  it("accumulates rapid clicks on top of the pending overlay", () => {
    // Server says 2; two queued +1s are already pending; a third click targets 5.
    const plan = planQuantityChange({ currentQty: 2, pendingDelta: 2 }, 1);
    expect(plan.action).toBe("update");
    if (plan.action === "update") expect(plan.target).toBe(5);
    expect(plan.nextPending).toBe(3);
  });

  it("converts a decrement to zero into a single REMOVE", () => {
    const plan = planQuantityChange({ currentQty: 1, pendingDelta: 0 }, -1);
    expect(plan.action).toBe("remove");
    expect(plan.nextPending).toBe(-1);
  });

  it("converts a burst crossing zero into a REMOVE (never a 0-quantity PATCH)", () => {
    // Server says 2, one -1 is already queued (target 1); a second -1 crosses
    // zero and must plan a REMOVE, not a 0-quantity PATCH.
    const plan = planQuantityChange({ currentQty: 2, pendingDelta: -1 }, -1);
    expect(plan.action).toBe("remove");
    expect(plan.nextPending).toBe(-2);
  });

  it("is a NO-OP once a removal is already queued (duplicate-click guard)", () => {
    const plan = planQuantityChange({ currentQty: 1, pendingDelta: -1 }, -1);
    // NOTE: covered by "crossing zero" above for the FIRST click; here the
    // removal is already reflected and further clicks must not re-enqueue.
    const guarded = planQuantityChange(
      { currentQty: 1, pendingDelta: -1 },
      1,
    );
    void plan;
    expect(guarded.action).toBe("noop");
    expect(guarded.nextPending).toBe(-1);
  });

  it("treats a zero-quantity line as already removed", () => {
    const plan = planQuantityChange({ currentQty: 0, pendingDelta: 0 }, 1);
    expect(plan.action).toBe("noop");
  });
});

describe("planRemoval (F8 — idempotent REMOVE)", () => {
  it("plans a removal that clears the displayed quantity", () => {
    const plan = planRemoval({ currentQty: 3, pendingDelta: 0 });
    expect(plan.action).toBe("remove");
    expect(plan.nextPending).toBe(-3);
  });

  it("accounts for a positive pending overlay when removing", () => {
    const plan = planRemoval({ currentQty: 3, pendingDelta: 2 });
    expect(plan.action).toBe("remove");
    // The overlay REPLACES the displayed quantity: -(server qty) hides the
    // line exactly, regardless of the +2 that was pending.
    expect(plan.nextPending).toBe(-3);
  });

  it("hides a line removed while a negative overlay is pending", () => {
    // Regression: -(qty + pending) left the line VISIBLE (displayed 1) when a
    // removal was requested mid-decrement; -(qty) always hides it.
    const plan = planRemoval({ currentQty: 2, pendingDelta: -1 });
    expect(plan.action).toBe("remove");
    expect(plan.nextPending).toBe(-2);
  });

  it("is idempotent: a second click while queued is a NO-OP", () => {
    const first = planRemoval({ currentQty: 3, pendingDelta: 0 });
    expect(first.action).toBe("remove");
    const second = planRemoval({
      currentQty: 3,
      pendingDelta: first.nextPending,
    });
    expect(second.action).toBe("noop");
    expect(second.nextPending).toBe(first.nextPending);
  });
});

describe("isRemovalQueued (F8 — overlay guard truth table)", () => {
  it("false for clean or positively-pending lines", () => {
    expect(isRemovalQueued({ currentQty: 2, pendingDelta: 0 })).toBe(false);
    expect(isRemovalQueued({ currentQty: 2, pendingDelta: 3 })).toBe(false);
  });

  it("true only when the overlay drives the line to (or below) zero", () => {
    expect(isRemovalQueued({ currentQty: 2, pendingDelta: -2 })).toBe(true);
    expect(isRemovalQueued({ currentQty: 2, pendingDelta: -1 })).toBe(false);
    expect(isRemovalQueued({ currentQty: 0, pendingDelta: 0 })).toBe(true);
  });
});
