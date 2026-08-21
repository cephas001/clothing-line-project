// apps/storefront/src/lib/passwordReset.ts
//
// G006 — password-reset form rules (pure logic, no React, no HTTP).
//
// The API contract (openapi.yaml) is the source of truth:
//   - initiate: `{ email }` -> ALWAYS 204 for a well-formed request. Unknown
//     emails are indistinguishable from known ones (anti-enumeration), so the
//     UI presents ONE outcome message regardless of who exists.
//   - complete: `{ resetToken, newPassword }` with newPassword 8–256 chars;
//     invalid/expired/used tokens yield 401 UNAUTHORIZED_ACCESS.
//
// Security posture: the reset token lives only in component state for the
// duration of the flow and is never logged; passwords are never persisted
// anywhere by this module.

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;

/** The single anti-enumeration outcome for initiate — identical for every email. */
export const PASSWORD_RESET_REQUESTED_MESSAGE =
  "If an account exists for that email, a reset link is on its way. Check your inbox.";

/** Success outcome for complete — the sessions were revoked server-side. */
export const PASSWORD_RESET_COMPLETED_MESSAGE =
  "Password updated. Sign in with your new password.";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Client-side pre-flight only; the server stays authoritative. */
export function validateResetEmail(email: string): string | null {
  const value = email.trim();
  if (value === "") return "Enter your email address.";
  if (!EMAIL_PATTERN.test(value)) return "Enter a valid email address.";
  return null;
}

/** Contract bounds: minLength 8, maxLength 256. */
export function validateNewPassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  return null;
}

export function validatePasswordConfirmation(
  password: string,
  confirmation: string,
): string | null {
  if (password !== confirmation) return "Passwords do not match.";
  return null;
}
