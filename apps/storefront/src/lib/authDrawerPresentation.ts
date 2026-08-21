// apps/storefront/src/lib/authDrawerPresentation.ts
//
// F9 / E7 — pure AuthDrawer state rules.
//
// The drawer's four screens (login, register, forgot-request, forgot-confirm)
// and their headings, submit labels and client-side validation live here as
// testable functions. Nothing in this module persists ANYTHING: passwords,
// reset tokens and emails exist only as function inputs/outputs for the
// component's ephemeral state — there is no storage access of any kind.
// Server-side truth (JWT identity, 401 on bad tokens) is owned by
// AuthContext / lib/api/customers.ts; this module only shapes presentation.

import {
  validateNewPassword,
  validatePasswordConfirmation,
  validateResetEmail,
} from "./passwordReset";

export type AuthDrawerMode = "login" | "register" | "forgot";
export type ForgotStage = "request" | "confirm";

/** The concrete screen the drawer renders. */
export type AuthDrawerScreen =
  | "login"
  | "register"
  | "forgot-request"
  | "forgot-confirm";

export function authDrawerScreen(
  mode: AuthDrawerMode,
  forgotStage: ForgotStage,
): AuthDrawerScreen {
  if (mode === "login") return "login";
  if (mode === "register") return "register";
  return forgotStage === "request" ? "forgot-request" : "forgot-confirm";
}

/** The drawer heading per screen. */
export function authDrawerHeading(screen: AuthDrawerScreen): string {
  switch (screen) {
    case "login":
      return "SIGN IN";
    case "register":
      return "CREATE ACCOUNT";
    case "forgot-request":
      return "RESET PASSWORD";
    case "forgot-confirm":
      return "SET NEW PASSWORD";
  }
}

/** The submit button label, honest about the in-flight work. */
export function authDrawerSubmitLabel(
  screen: AuthDrawerScreen,
  submitting: boolean,
): string {
  switch (screen) {
    case "login":
      return submitting ? "SIGNING IN…" : "SIGN IN";
    case "register":
      return submitting ? "CREATING ACCOUNT…" : "CREATE ACCOUNT";
    case "forgot-request":
      return submitting ? "SENDING…" : "SEND RESET LINK";
    case "forgot-confirm":
      return submitting ? "UPDATING…" : "UPDATE PASSWORD";
  }
}

export interface AuthSubmitInput {
  screen: AuthDrawerScreen;
  resetEmail: string;
  resetToken: string;
  newPassword: string;
  confirmPassword: string;
}

/**
 * Client-side validation BEFORE any request fires, in declaration order.
 * Login/register rely on the server + HTML constraints (null here); the
 * forgot flow validates locally because the contract's errors would otherwise
 * leak account existence or burn a round-trip on malformed input.
 * Returns the FIRST error, or null when the submit may proceed.
 */
export function authDrawerSubmitError(input: AuthSubmitInput): string | null {
  if (input.screen === "forgot-request") {
    return validateResetEmail(input.resetEmail);
  }
  if (input.screen === "forgot-confirm") {
    const tokenError =
      input.resetToken.trim() === ""
        ? "Paste the reset token from your email."
        : null;
    if (tokenError) return tokenError;
    const passwordError = validateNewPassword(input.newPassword);
    if (passwordError) return passwordError;
    return validatePasswordConfirmation(input.newPassword, input.confirmPassword);
  }
  return null;
}
