// apps/storefront/tests/unit/addressPrefill.test.ts
//
// Slice 2B — authenticated checkout address prefill rules (pure logic):
// the default address wins, empty form fields are filled, user input is never
// clobbered, and prefill alone NEVER marks the address as saved/submitted.
//
// F6.6-G002 — the fetch attempt follows a pure lifecycle (not_started →
// in_flight → completed, interrupted in-flight → not_started) so Strict
// Mode's simulated unmount cancels the first attempt AND the remount starts
// a second valid one; a completed prefill is never redone.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  pickPrefillAddress,
  prefillAddressForm,
  prefillCanStart,
  prefillInterrupted,
  type PrefillLifecycle,
} from "../../src/lib/addressPrefill";
import { makeAddress } from "../helpers/fixtures";

const EMPTY_FORM = {
  firstName: "",
  lastName: "",
  phone: "",
  line1: "",
  city: "",
  state: "",
  postalCode: "",
};

describe("pickPrefillAddress", () => {
  it("prefers the default address", () => {
    const first = makeAddress({ id: "addr-first", isDefault: false });
    const def = makeAddress({ id: "addr-default", isDefault: true });
    expect(pickPrefillAddress([first, def])?.id).toBe("addr-default");
  });

  it("falls back to the first entry without a default", () => {
    const first = makeAddress({ id: "addr-first", isDefault: false });
    const second = makeAddress({ id: "addr-second", isDefault: false });
    expect(pickPrefillAddress([first, second])?.id).toBe("addr-first");
  });

  it("offers nothing for an empty address book", () => {
    expect(pickPrefillAddress([])).toBeNull();
  });
});

describe("prefillAddressForm", () => {
  it("fills every empty field from the saved address", () => {
    const next = prefillAddressForm(EMPTY_FORM, makeAddress());
    expect(next.firstName).toBe("Ada");
    expect(next.lastName).toBe("Lovelace");
    expect(next.line1).toBe("1 Test Street");
    expect(next.city).toBe("Lagos");
    expect(next.state).toBe("LA");
    expect(next.postalCode).toBe("100001");
    expect(next.phone).toBe("+2348000000000");
  });

  it("never clobbers fields the customer already typed", () => {
    const typed = { ...EMPTY_FORM, city: "Abuja", phone: "+234999" };
    const next = prefillAddressForm(typed, makeAddress());
    expect(next.city).toBe("Abuja");
    expect(next.phone).toBe("+234999");
    expect(next.line1).toBe("1 Test Street");
  });

  it("returns the SAME reference when there is nothing to fill (no effect loops)", () => {
    const full = {
      firstName: "A",
      lastName: "B",
      phone: "C",
      line1: "D",
      city: "E",
      state: "F",
      postalCode: "G",
    };
    expect(prefillAddressForm(full, makeAddress())).toBe(full);
    expect(prefillAddressForm(EMPTY_FORM, null)).toBe(EMPTY_FORM);
  });

  it("ignores blank address values instead of writing whitespace into the form", () => {
    const sparse = makeAddress({ city: "   ", state: undefined as unknown as string });
    const next = prefillAddressForm(EMPTY_FORM, sparse);
    expect(next.city).toBe("");
    expect(next.state).toBe("");
  });
});

describe("prefill lifecycle (F6.6-G002)", () => {
  it("only a not_started attempt may begin — a live one is never doubled", () => {
    expect(prefillCanStart("not_started")).toBe(true);
    expect(prefillCanStart("in_flight")).toBe(false);
    expect(prefillCanStart("completed")).toBe(false);
  });

  it("an interrupted IN-FLIGHT attempt is released so the remount may retry", () => {
    expect(prefillInterrupted("in_flight")).toBe("not_started");
  });

  it("a COMPLETED prefill is never redone by an interruption or remount", () => {
    expect(prefillInterrupted("completed")).toBe("completed");
  });

  it("interrupting a not_started state is a no-op", () => {
    expect(prefillInterrupted("not_started")).toBe("not_started");
  });

  it("Strict Mode sequence: start → cancel → start again → finish → cleanup never revives it", () => {
    let state: PrefillLifecycle = "not_started";

    // Strict Mode run #1: effect starts the fetch.
    expect(prefillCanStart(state)).toBe(true);
    state = "in_flight";
    // Simulated unmount cancels run #1 before completion.
    state = prefillInterrupted(state);
    expect(state).toBe("not_started");

    // Strict Mode remount (run #2): a SECOND VALID attempt is allowed.
    expect(prefillCanStart(state)).toBe(true);
    state = "in_flight";
    // The second attempt completes and applies.
    state = "completed";

    // Any later cleanup (navigation, unmount) must NOT revive the attempt.
    expect(prefillInterrupted(state)).toBe("completed");
    expect(prefillCanStart(state)).toBe(false);
  });

  it("a failed attempt completes the lifecycle — no retry loops on re-renders", () => {
    let state: PrefillLifecycle = "not_started";
    state = "in_flight";
    // Failure path marks completed (best-effort, documented).
    state = "completed";
    expect(prefillCanStart(state)).toBe(false);
    expect(prefillInterrupted(state)).toBe("completed");
  });
});
