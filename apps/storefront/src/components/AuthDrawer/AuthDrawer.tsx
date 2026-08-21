// apps/storefront/src/components/AuthDrawer/AuthDrawer.tsx
//
// Login / Register / Forgot-password drawer. Follows the existing CartDrawer
// visual language (right-side panel, ink/paper mono styling).
//
// State handling is centralized: submitting disables the form, API errors are
// normalized to ApiError and rendered inline, and success closes the drawer
// with a toast. Identity is established by AuthContext (JWT from
// POST /store/auth), never by a client-supplied customerId.
//
// G006 — password reset (exact contract semantics):
//   Login -> "FORGOT PASSWORD?" -> initiate (`{email}` -> ALWAYS 204 for a
//   well-formed request; unknown emails are indistinguishable, so ONE outcome
//   message is shown) -> confirm (`{resetToken, newPassword}` from the emailed
//   token; invalid/expired tokens surface the server's 401 UNAUTHORIZED_ACCESS)
//   -> back to Sign in with a success notice. The reset token lives only in
//   component state for the duration of the flow and is never logged;
//   passwords are never persisted anywhere.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { errorMessageOf } from "@/lib/errorPresentation";
import { useDialogOverlay } from "@/lib/dialogA11y";
import { useToast } from "@/context/ToastContext";
import {
  completePasswordReset,
  initiatePasswordReset,
} from "@/lib/api/customers";
import {
  PASSWORD_RESET_COMPLETED_MESSAGE,
  PASSWORD_RESET_REQUESTED_MESSAGE,
} from "@/lib/passwordReset";
import {
  authDrawerScreen,
  authDrawerHeading,
  authDrawerSubmitError,
  authDrawerSubmitLabel,
  type AuthDrawerMode,
  type ForgotStage,
} from "@/lib/authDrawerPresentation";

// Screen/mode/stage types come from lib/authDrawerPresentation.ts (F9/E7).

const inputClass =
  "w-full border border-ink bg-transparent px-4 py-3 font-mono text-[13px] outline-none focus:border-ink";

const linkClass =
  "cursor-pointer border-none bg-transparent p-0 font-mono text-[10px] uppercase tracking-[0.06em] text-muted underline underline-offset-2 hover:text-ink";

export default function AuthDrawer() {
  const { isOpen, closeAuth, login, register } = useAuth();
  const { showToast } = useToast();
  // F8: shared overlay behavior — Escape closes, Tab cycles inside the
  // panel, focus enters on open and returns to the opener on close.
  const panelRef = useDialogOverlay({ open: isOpen, onClose: closeAuth });

  const [mode, setMode] = useState<AuthDrawerMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  const [forgotStage, setForgotStage] = useState<ForgotStage>("request");
  const [resetEmail, setResetEmail] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Page unable to scroll while the drawer is open (mirrors CartDrawer).
  useEffect(() => {
    document.body.style.overflow = isOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  // F6.6-G003 — deferred post-close reset, with full timer lifecycle cleanup.
  // The form reset is delayed so the drawer's exit animation finishes first.
  // The handle lives in a ref and is cleared:
  //   1. before scheduling a new reset (never two pending resets),
  //   2. when the drawer REOPENS (a quick close→reopen must not wipe the
  //      freshly opened form underneath the customer),
  //   3. on unmount (no dangling timer firing into a dead component).
  const resetTimerRef = useRef<number | null>(null);
  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  // Reopen cancels any still-pending reset from the previous close.
  useEffect(() => {
    if (isOpen) clearResetTimer();
  }, [isOpen, clearResetTimer]);

  // Unmount-only cleanup (stable deps): the last pending timer is cleared.
  useEffect(() => clearResetTimer, [clearResetTimer]);

  const switchMode = (next: AuthDrawerMode) => {
    setMode(next);
    setError(null);
    setNotice(null);
    if (next === "forgot") setForgotStage("request");
  };

  const closeAndReset = () => {
    closeAuth();
    clearResetTimer();
    // Reset after the drawer animation so the form is fresh next time.
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null;
      setMode("login");
      setEmail("");
      setPassword("");
      setFirstName("");
      setLastName("");
      setForgotStage("request");
      setResetEmail("");
      setResetToken("");
      setNewPassword("");
      setConfirmPassword("");
      setError(null);
      setNotice(null);
      setSubmitting(false);
    }, 300);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const screen = authDrawerScreen(mode, forgotStage);
    // F9/E7: client-side validation is a pure rule; login/register rely on
    // the server + HTML constraints.
    const validationError = authDrawerSubmitError({
      screen,
      resetEmail,
      resetToken,
      newPassword,
      confirmPassword,
    });
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "login") {
        await login(email.trim(), password);
        showToast("Signed in.");
      } else if (mode === "register") {
        await register({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          password,
        });
        showToast("Account created.");
      } else if (forgotStage === "request") {
        // Contract: 204 regardless of whether the account exists.
        await initiatePasswordReset(resetEmail.trim());
        setNotice(PASSWORD_RESET_REQUESTED_MESSAGE);
        setForgotStage("confirm");
      } else {
        // Invalid/expired/used tokens resolve to 401 UNAUTHORIZED_ACCESS and
        // surface below via the canonical envelope message. The token and
        // passwords live only in component state and are never persisted.
        await completePasswordReset(resetToken.trim(), newPassword);
        setResetToken("");
        setNewPassword("");
        setConfirmPassword("");
        setMode("login");
        setNotice(PASSWORD_RESET_COMPLETED_MESSAGE);
      }
    } catch (err) {
      // F8: one presentation rule — truthful backend messages verbatim, a
      // curated line for transport failures, generic only for junk.
      setError(errorMessageOf(err));
    } finally {
      setSubmitting(false);
    }
  };

  // F9/E7: headings and submit labels are pure functions of the screen.
  const screen = authDrawerScreen(mode, forgotStage);
  const headingLabel = authDrawerHeading(screen);
  const submitLabel = authDrawerSubmitLabel(screen, submitting);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            key="auth-backdrop"
            onClick={closeAndReset}
            className="fixed inset-0 z-[150] bg-black/60"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          />
          <motion.aside
            key="auth-panel"
            ref={panelRef}
            role="dialog"
            aria-label="Account"
            className="fixed inset-y-0 right-0 z-[160] flex h-full w-[85%] flex-col border-l border-ink bg-paper md:w-[420px]"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="flex flex-shrink-0 items-center justify-between border-b border-ink p-5 md:p-6">
              <div className="font-display text-[14px] font-bold uppercase tracking-[0.05em] md:text-[16px] md:tracking-[0.06em]">
                {headingLabel}
              </div>
              <button
                type="button"
                onClick={closeAndReset}
                aria-label="Close account"
                className="cursor-pointer border-none bg-transparent p-1 text-ink"
              >
                <X size={20} strokeWidth={1.5} />
              </button>
            </div>

            {mode !== "forgot" && (
              <div className="flex gap-2 border-b border-ink p-5 md:p-6 md:pb-5">
                {(["login", "register"] as const).map((tab) => {
                  const active = mode === tab;
                  return (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => switchMode(tab)}
                      className={`cursor-pointer border border-ink px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.06em] ${
                        active
                          ? "bg-ink text-paper-2"
                          : "bg-transparent text-ink hover:opacity-70"
                      }`}
                    >
                      {tab === "login" ? "SIGN IN" : "REGISTER"}
                    </button>
                  );
                })}
              </div>
            )}

            <form
              onSubmit={handleSubmit}
              className="flex flex-1 flex-col gap-4 overflow-y-auto p-5 md:p-6"
            >
              {mode === "register" && (
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="text"
                    aria-label="FIRST NAME"
                    placeholder="FIRST NAME"
                    required
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className={inputClass}
                  />
                  <input
                    type="text"
                    aria-label="LAST NAME"
                    placeholder="LAST NAME"
                    required
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className={inputClass}
                  />
                </div>
              )}

              {mode === "forgot" && forgotStage === "request" && (
                <p className="font-mono text-[11px] leading-relaxed tracking-[0.02em] text-muted">
                  Enter the email on your account and we&apos;ll send a reset
                  link.
                </p>
              )}
              {mode === "forgot" && forgotStage === "confirm" && (
                <p className="font-mono text-[11px] leading-relaxed tracking-[0.02em] text-muted">
                  Paste the reset token from the email, then choose a new
                  password (8–256 characters).
                </p>
              )}

              {(mode === "login" || mode === "register") && (
                <input
                  type="email"
                  aria-label="EMAIL"
                  placeholder="EMAIL"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputClass}
                />
              )}

              {mode === "forgot" && forgotStage === "request" && (
                <input
                  type="email"
                  aria-label="EMAIL"
                  placeholder="EMAIL"
                  required
                  autoComplete="email"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  className={inputClass}
                />
              )}

              {mode === "forgot" && forgotStage === "confirm" && (
                <>
                  <input
                    type="text"
                    aria-label="RESET TOKEN"
                    placeholder="RESET TOKEN"
                    required
                    value={resetToken}
                    onChange={(e) => setResetToken(e.target.value)}
                    className={inputClass}
                  />
                  <input
                    type="password"
                    aria-label="NEW PASSWORD"
                    placeholder="NEW PASSWORD"
                    required
                    minLength={8}
                    maxLength={256}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className={inputClass}
                  />
                  <input
                    type="password"
                    aria-label="CONFIRM NEW PASSWORD"
                    placeholder="CONFIRM NEW PASSWORD"
                    required
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className={inputClass}
                  />
                </>
              )}

              {(mode === "login" || mode === "register") && (
                <input
                  type="password"
                  aria-label="PASSWORD"
                  placeholder="PASSWORD"
                  required
                  minLength={mode === "register" ? 8 : undefined}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputClass}
                />
              )}

              {error && (
                <div className="border border-ink bg-paper px-4 py-3 font-mono text-[11px] tracking-[0.04em] text-ink">
                  {error}
                </div>
              )}
              {!error && notice && (
                <div className="border border-[#e5e3df] bg-paper px-4 py-3 font-mono text-[11px] leading-relaxed tracking-[0.04em] text-muted">
                  {notice}
                </div>
              )}

              {mode === "login" && (
                <button
                  type="button"
                  onClick={() => switchMode("forgot")}
                  className={`self-start ${linkClass}`}
                >
                  FORGOT PASSWORD?
                </button>
              )}
              {mode === "forgot" && (
                <button
                  type="button"
                  onClick={() => switchMode("login")}
                  className={`self-start ${linkClass}`}
                >
                  ← BACK TO SIGN IN
                </button>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="mt-auto h-12 w-full cursor-pointer border-none bg-ink text-[12px] font-mono uppercase tracking-[0.08em] text-paper-2 hover:!bg-paper-2 hover:!text-ink hover:!shadow-[inset_0_0_0_1px_theme(colors.ink)] disabled:cursor-not-allowed disabled:!bg-disabled disabled:!text-muted md:h-[52px] md:text-[13px] md:tracking-[0.1em]"
              >
                {submitLabel}
              </button>
            </form>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
