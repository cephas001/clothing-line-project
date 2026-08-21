// apps/storefront/tests/unit/wishlistStorage.test.ts
//
// F6.6-G004 — wishlist localStorage parsing is hardened: ONLY an array of
// strings is accepted; malformed JSON, wrong-shaped values (objects,
// numbers, arrays containing non-strings) and storage failures all fail safe
// to [] — never throwing, never crashing render. Valid data is preserved.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { resetClientStorage } from "../helpers/env";
import {
  WISHLIST_STORAGE_KEY,
  isStringIdList,
  readWishlist,
  writeWishlist,
} from "../../src/lib/wishlistStorage";

describe("isStringIdList (F6.6-G004 validator)", () => {
  it("accepts only arrays of strings", () => {
    expect(isStringIdList([])).toBe(true);
    expect(isStringIdList(["a", "b"])).toBe(true);
    expect(isStringIdList([""])).toBe(true);
  });

  it("rejects wrong-shaped values", () => {
    expect(isStringIdList({ unexpected: "object" })).toBe(false);
    expect(isStringIdList("saved")).toBe(false);
    expect(isStringIdList(5)).toBe(false);
    expect(isStringIdList(null)).toBe(false);
    expect(isStringIdList(undefined)).toBe(false);
    expect(isStringIdList([1, "a"])).toBe(false);
    expect(isStringIdList(["a", null])).toBe(false);
    expect(isStringIdList([{ id: "a" }])).toBe(false);
  });
});

describe("readWishlist (F6.6-G004 parsing)", () => {
  it("returns [] when nothing is stored", () => {
    resetClientStorage();
    expect(readWishlist()).toEqual([]);
  });

  it("preserves a valid persisted list", () => {
    resetClientStorage();
    window.localStorage.setItem(
      WISHLIST_STORAGE_KEY,
      JSON.stringify(["prod-1", "prod-2"]),
    );
    expect(readWishlist()).toEqual(["prod-1", "prod-2"]);
  });

  it("discards malformed JSON instead of throwing", () => {
    resetClientStorage();
    window.localStorage.setItem(WISHLIST_STORAGE_KEY, "{not json");
    expect(readWishlist()).toEqual([]);
  });

  it("discards valid-JSON wrong shapes (the G004 crash case)", () => {
    resetClientStorage();
    window.localStorage.setItem(
      WISHLIST_STORAGE_KEY,
      '{"unexpected":"object"}',
    );
    expect(readWishlist()).toEqual([]);

    window.localStorage.setItem(WISHLIST_STORAGE_KEY, "42");
    expect(readWishlist()).toEqual([]);

    window.localStorage.setItem(WISHLIST_STORAGE_KEY, '"just-a-string"');
    expect(readWishlist()).toEqual([]);

    window.localStorage.setItem(WISHLIST_STORAGE_KEY, "null");
    expect(readWishlist()).toEqual([]);
  });

  it("discards arrays containing non-string elements", () => {
    resetClientStorage();
    window.localStorage.setItem(WISHLIST_STORAGE_KEY, '["a",1,null]');
    expect(readWishlist()).toEqual([]);
  });
});

describe("writeWishlist / readWishlist round-trip", () => {
  it("persists and restores the same list", () => {
    resetClientStorage();
    writeWishlist(["prod-a", "prod-b"]);
    expect(readWishlist()).toEqual(["prod-a", "prod-b"]);
  });

  it("overwrites a previously corrupt value with the next valid write", () => {
    resetClientStorage();
    window.localStorage.setItem(WISHLIST_STORAGE_KEY, '{"unexpected":"object"}');
    expect(readWishlist()).toEqual([]);
    writeWishlist(["prod-c"]);
    expect(readWishlist()).toEqual(["prod-c"]);
  });
});
