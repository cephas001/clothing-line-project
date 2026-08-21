// apps/storefront/tests/unit/authDrawerPresentation.test.ts
//
// F9 / E7 — pure AuthDrawer state rules (src/lib/authDrawerPresentation.ts).
// Screens, headings, submit labels and pre-submit validation are pure; the
// module performs NO storage access — passwords and reset tokens exist only
// as transient inputs/outputs.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  authDrawerHeading,
  authDrawerScreen,
  authDrawerSubmitError,
  authDrawerSubmitLabel,
} from "../../src/lib/authDrawerPresentation";

describe("authDrawerScreen — mode/stage mapping", () => {
  it("maps login and register directly", () => {
    expect(authDrawerScreen("login", "request")).toBe("login");
    expect(authDrawerScreen("register", "request")).toBe("register");
  });

  it("splits the forgot flow into request and confirm screens", () => {
    expect(authDrawerScreen("forgot", "request")).toBe("forgot-request");
    expect(authDrawerScreen("forgot", "confirm")).toBe("forgot-confirm");
  });
});

describe("authDrawerHeading / authDrawerSubmitLabel — presentation", () => {
  it("heads each screen distinctly", () => {
    const headings = (["login", "register", "forgot-request", "forgot-confirm"] as const).map(
      authDrawerHeading,
    );
    expect(new Set(headings).size).toBe(4);
    expect(headings[0]).toBe("SIGN IN");
    expect(headings[3]).toBe("SET NEW PASSWORD");
  });

  it("submit labels are honest about the in-flight work", () => {
    expect(authDrawerSubmitLabel("login", false)).toBe("SIGN IN");
    expect(authDrawerSubmitLabel("login", true)).toBe("SIGNING IN…");
    expect(authDrawerSubmitLabel("register", true)).toContain("CREATING");
    expect(authDrawerSubmitLabel("forgot-request", true)).toBe("SENDING…");
    expect(authDrawerSubmitLabel("forgot-request", false)).toBe(
      "SEND RESET LINK",
    );
    expect(authDrawerSubmitLabel("forgot-confirm", true)).toBe("UPDATING…");
    expect(authDrawerSubmitLabel("forgot-confirm", false)).toBe(
      "UPDATE PASSWORD",
    );
  });
});

describe("authDrawerSubmitError — pre-submit validation order", () => {
  it("login/register defer to the server (no local error)", () => {
    expect(
      authDrawerSubmitError({
        screen: "login",
        resetEmail: "",
        resetToken: "",
        newPassword: "",
        confirmPassword: "",
      }),
    ).toBeNull();
    expect(
      authDrawerSubmitError({
        screen: "register",
        resetEmail: "",
        resetToken: "",
        newPassword: "",
        confirmPassword: "",
      }),
    ).toBeNull();
  });

  it("forgot-request validates the email first", () => {
    const error = authDrawerSubmitError({
      screen: "forgot-request",
      resetEmail: "not-an-email",
      resetToken: "",
      newPassword: "",
      confirmPassword: "",
    });
    expect(error).not.toBeNull();
  });

  it("forgot-confirm requires the token before anything else", () => {
    const error = authDrawerSubmitError({
      screen: "forgot-confirm",
      resetEmail: "",
      resetToken: "   ",
      newPassword: "short",
      confirmPassword: "different",
    });
    expect(error?.toLowerCase()).toContain("reset token");
  });

  it("forgot-confirm then enforces the password rules and match", () => {
    const base = { screen: "forgot-confirm" as const, resetEmail: "", resetToken: "tok" };
    const weak = authDrawerSubmitError({
      ...base,
      newPassword: "short",
      confirmPassword: "short",
    });
    expect(weak).not.toBeNull();

    const mismatch = authDrawerSubmitError({
      ...base,
      newPassword: "longenough1",
      confirmPassword: "longenough2",
    });
    expect(mismatch).not.toBeNull();

    const ok = authDrawerSubmitError({
      ...base,
      newPassword: "longenough1",
      confirmPassword: "longenough1",
    });
    expect(ok).toBeNull();
  });
});
