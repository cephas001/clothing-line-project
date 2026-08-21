// apps/storefront/src/context/AuthContext.tsx
//
// Customer identity + authentication session.
//
// Identity ALWAYS comes from the authenticated session: the JWT issued by
// `POST /store/auth` (persisted in localStorage) resolved to a Customer via
// `GET /store/customers/me`. No backend credentials are ever embedded in the
// frontend. The token is attached to authenticated requests by the API client.
//
// Lifecycle:
//   - On mount: a stored token is revalidated against `/me`.
//   - login()   -> POST /store/auth, store token, fetch profile.
//   - register()-> POST /store/customers, then auto-login (register returns a
//                  profile but no token).
//   - logout()  -> POST /store/customers/logout (best-effort denylist), then
//                  clear the local token regardless of network state.
//   - A 401/UNAUTHORIZED_ACCESS on `/me` clears the token and falls back to
//                  guest (no refresh endpoint exists).

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { clearToken, getToken, setToken } from "@/lib/api/auth";
import {
  getMe,
  login as loginRequest,
  logout as logoutRequest,
  register as registerRequest,
} from "@/lib/api/customers";
import {
  ApiError,
  isApiError,
  normalizeApiError,
} from "@/lib/api/errors";
import type { Customer, RegisterCustomerRequest } from "@/lib/types";

export type AuthStatus = "loading" | "authenticated" | "guest" | "error";

export interface AuthContextValue {
  customer: Customer | null;
  status: AuthStatus;
  error: ApiError | null;
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterCustomerRequest) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  /** AuthDrawer visibility (driven by the Header account button). */
  isOpen: boolean;
  openAuth: () => void;
  closeAuth: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Initial identity derives synchronously from the stored token: guests are
  // known immediately; a stored token starts the revalidation ("loading").
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [status, setStatus] = useState<AuthStatus>(() =>
    getToken() ? "loading" : "guest",
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  /**
   * Re-resolve the identity from the stored token (no-op for guests).
   * F8: concurrent callers SHARE one in-flight request — Strict Mode's
   * double-mounted effect and a login() that awaits reload() can never issue
   * duplicate GET /me calls, and the ref clears on completion so a later
   * retry genuinely re-runs.
   */
  const reloadInFlightRef = useRef<Promise<void> | null>(null);
  const reload = useCallback(async (): Promise<void> => {
    if (!getToken()) return;
    if (reloadInFlightRef.current) return reloadInFlightRef.current;
    const run = (async () => {
      try {
        const me = await getMe();
        setCustomer(me);
        setStatus("authenticated");
        setError(null);
      } catch (err) {
        const apiErr = isApiError(err) ? err : normalizeApiError(err);
        if (isApiError(err) && (err.status === 401 || err.code === "UNAUTHORIZED_ACCESS")) {
          // Expired/revoked token with no refresh path: clear and go guest.
          clearToken();
          setCustomer(null);
          setStatus("guest");
        } else {
          setStatus("error");
          setError(apiErr);
        }
      }
    })();
    reloadInFlightRef.current = run;
    try {
      await run;
    } finally {
      reloadInFlightRef.current = null;
    }
  }, []);

  useEffect(() => {
    // Revalidate a stored token once on mount. Deferred out of the
    // synchronous effect body (setState-in-effect), matching React 19's
    // effect guidance: the async work happens in a timer callback.
    const handle = setTimeout(() => {
      void reload();
    }, 0);
    return () => clearTimeout(handle);
  }, [reload]);

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      setError(null);
      const { accessToken } = await loginRequest({ email, password });
      setToken(accessToken);
      await reload();
      setIsOpen(false);
    },
    [reload],
  );

  const register = useCallback(
    async (input: RegisterCustomerRequest): Promise<void> => {
      setError(null);
      await registerRequest(input);
      // Registration returns a profile but no token; auto-login to establish
      // the session (identity still comes from the issued JWT).
      await login(input.email, input.password);
    },
    [login],
  );

  const logout = useCallback(async (): Promise<void> => {
    // F8: clear the authenticated presentation SYNCHRONOUSLY, BEFORE any
    // network round trip — the UI flips to guest immediately (no flash of
    // authenticated chrome) and no component can fire another protected
    // request against a dying session. The server-side denylist revoke is
    // best-effort and uses the token captured above; a failed revoke never
    // blocks or delays sign-out.
    const token = getToken();
    clearToken();
    setCustomer(null);
    setStatus("guest");
    setError(null);
    if (token) {
      try {
        await logoutRequest(token);
      } catch {
        // Best-effort: the local session is already gone.
      }
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      customer,
      status,
      error,
      login,
      register,
      logout,
      reload,
      isOpen,
      openAuth: () => setIsOpen(true),
      closeAuth: () => setIsOpen(false),
    }),
    [customer, status, error, login, register, logout, reload, isOpen],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return context;
}