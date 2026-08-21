// apps/storefront/tests/unit/dialogA11y.test.ts
//
// F8 Part 4 — pure overlay-dialog decision rules (src/lib/dialogA11y.ts):
// Escape detection and the Tab-cycling math that keeps focus inside an open
// drawer without ever trapping it on a single focusable element.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { isEscapeKey, nextTabWrap } from "../../src/lib/dialogA11y";

const keyEvent = (overrides: Partial<{
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}> = {}) => ({
  key: "Escape",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

describe("isEscapeKey", () => {
  it("a bare Escape closes the overlay", () => {
    expect(isEscapeKey(keyEvent())).toBe(true);
    expect(isEscapeKey(keyEvent({ shiftKey: true }))).toBe(true);
  });

  it("modified Escapes and other keys do not close", () => {
    expect(isEscapeKey(keyEvent({ ctrlKey: true }))).toBe(false);
    expect(isEscapeKey(keyEvent({ metaKey: true }))).toBe(false);
    expect(isEscapeKey(keyEvent({ altKey: true }))).toBe(false);
    expect(isEscapeKey(keyEvent({ key: "Tab" }))).toBe(false);
    expect(isEscapeKey(keyEvent({ key: "Enter" }))).toBe(false);
  });
});

describe("nextTabWrap — focus cycling math", () => {
  it("steps forward and wraps last -> first", () => {
    expect(nextTabWrap(0, 3, false)).toBe(1);
    expect(nextTabWrap(1, 3, false)).toBe(2);
    expect(nextTabWrap(2, 3, false)).toBe(0);
  });

  it("steps backward and wraps first -> last", () => {
    expect(nextTabWrap(2, 3, true)).toBe(1);
    expect(nextTabWrap(0, 3, true)).toBe(2);
  });

  it("never traps on a single focusable element", () => {
    expect(nextTabWrap(0, 1, false)).toBe(null);
    expect(nextTabWrap(0, 1, true)).toBe(null);
    expect(nextTabWrap(0, 0, false)).toBe(null);
  });
});
