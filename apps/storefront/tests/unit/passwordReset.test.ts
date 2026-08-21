// apps/storefront/tests/unit/passwordReset.test.ts
//
// Slice 3 — G006 password-reset form rules (pure logic):
// contract bounds (newPassword 8–256), email pre-flight, confirmation match,
// and the single anti-enumeration outcome message for initiate.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_RESET_COMPLETED_MESSAGE,
  PASSWORD_RESET_REQUESTED_MESSAGE,
  validateNewPassword,
  validatePasswordConfirmation,
  validateResetEmail,
} from "../../src/lib/passwordReset";

describe("validateResetEmail", () => {
  it("accepts a well-formed email", () => {
    expect(validateResetEmail("ada@example.com")).toBeNull();
  });

  it("rejects empty and malformed emails before any request is made", () => {
    expect(validateResetEmail("")).not.toBeNull();
    expect(validateResetEmail("   ")).not.toBeNull();
    expect(validateResetEmail("not-an-email")).not.toBeNull();
    expect(validateResetEmail("missing@tld")).not.toBeNull();
  });
});

describe("validateNewPassword — contract bounds (minLength 8, maxLength 256)", () => {
  it("accepts passwords inside the bounds", () => {
    expect(validateNewPassword("12345678")).toBeNull();
    expect(validateNewPassword("a".repeat(PASSWORD_MAX_LENGTH))).toBeNull();
  });

  it("rejects below the minimum and above the maximum", () => {
    expect(validateNewPassword("1234567")).not.toBeNull();
    expect(validateNewPassword("a".repeat(PASSWORD_MAX_LENGTH + 1))).not.toBeNull();
  });

  it("messages state the exact bounds", () => {
    const tooShort = validateNewPassword("1234567") ?? "";
    expect(tooShort).toContain("8");
    const tooLong = validateNewPassword("a".repeat(257)) ?? "";
    expect(tooLong).toContain("256");
  });
});

describe("validatePasswordConfirmation", () => {
  it("requires an exact match", () => {
    expect(validatePasswordConfirmation("abcdef12", "abcdef12")).toBeNull();
    expect(validatePasswordConfirmation("abcdef12", "abcdef13")).not.toBeNull();
  });
});

describe("anti-enumeration semantics", () => {
  it("initiate has ONE outcome message for every email (204 always)", () => {
    // The message must not reveal whether the account exists.
    expect(PASSWORD_RESET_REQUESTED_MESSAGE).toContain("If an account exists");
  });

  it("complete reports success without echoing secrets", () => {
    expect(PASSWORD_RESET_COMPLETED_MESSAGE).toContain("Sign in");
    expect(PASSWORD_RESET_COMPLETED_MESSAGE.toLowerCase()).not.toContain("token");
  });
});
