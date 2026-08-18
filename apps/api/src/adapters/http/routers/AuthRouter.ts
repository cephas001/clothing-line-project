// apps/api/src/adapters/http/routers/AuthRouter.ts

// HTTP adapter for the storefront authentication endpoints:
//   POST /store/auth             -> AuthenticateCustomerUseCase
//   POST /store/customers/logout -> RevokeCustomerSessionUseCase
//
// Both endpoints are the TRANSPORT BOUNDARY ONLY. They perform, in order:
//   HTTP request
//     -> validate/map input (strict body contract: ONLY {email, password} on
//        auth, ONLY {reason} on logout — additionalProperties: false)
//     -> resolve the authenticated actor from the bearer JWT (reused auth.ts;
//        a customerId is NEVER accepted from a request body)
//     -> the use case (source of truth) -> map the result to the HTTP contract
// No account state, lockout, credential, or session logic exists here.
//
// Security notes:
//   - Auth is guest-optional (a presented-but-invalid token is still rejected).
//   - Logout REQUIRES a valid bearer token; the RAW token is revoked via the
//     denylist (RevokeCustomerSessionUseCase.activeToken). The identity comes
//     from the token, never from the client.
//   - Credential failures surface as INVALID_CREDENTIALS (401) so unknown
//     emails and bad passwords are indistinguishable. Locked accounts -> 423.
//   - Stack traces, tokens, and provider internals are never echoed.

import express from "express";
import type { Request, Response } from "express";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import type { AuthenticateCustomerUseCase } from "@api/use-cases/customers/AuthenticateCustomerUseCase";
import type { RevokeCustomerSessionUseCase } from "@api/use-cases/customers/RevokeCustomerSessionUseCase";
import { resolveActorAndTokenFromBearerToken } from "../middleware/auth";
import { parseStrictBodyObject } from "../middleware/body";
import {
  createBodyParseErrorHandler,
  mapDomainErrorToHttp,
  sendErrorResponse,
} from "../errors";

const AUTH_BODY_LIMIT = "100kb";
const AUTH_BODY_KEYS = ["email", "password"] as const;
const LOGOUT_BODY_KEYS = ["reason"] as const;

export interface AuthRouterDeps {
  /** Always wired: depends only on core dependencies. */
  authenticateCustomer: AuthenticateCustomerUseCase;
  /** Always wired: depends only on the session-revocation (Redis) service. */
  revokeCustomerSession: RevokeCustomerSessionUseCase;
  /** Verifies the bearer JWT into the actor identity (shared auth.ts). */
  tokenService: ITokenService;
  logger: ILogger;
}

export function createAuthRouter(deps: AuthRouterDeps): express.Router {
  const router = express.Router();

  // POST /auth — exchange credentials for a signed access token.
  router.post(
    "/auth",
    express.json({ limit: AUTH_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        // Strict contract: ONLY { email, password }. No identity, token,
        // device, or metadata fields are accepted from the client.
        const body = parseStrictBodyObject(req.body, AUTH_BODY_KEYS, [
          "email",
          "password",
        ]);
        const email = typeof body.email === "string" ? body.email.trim() : "";
        const passwordRaw =
          typeof body.password === "string" ? body.password : "";

        // A presented-but-invalid token is still rejected; guest auth (no
        // header) stays allowed and the actor defaults to "system" in the use
        // case audit trail.
        const resolved = await resolveActorAndTokenFromBearerToken(
          req,
          deps.tokenService,
        );

        const result = await deps.authenticateCustomer.execute({
          email,
          passwordRaw,
          actorId: resolved?.customerId,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        });

        res.status(200).json({ accessToken: result.accessToken });
      } catch (err: unknown) {
        const mapped = mapDomainErrorToHttp(err);
        deps.logger.warn("Authentication request rejected", {
          status: mapped.status,
          code: mapped.code,
        });
        sendErrorResponse(res, mapped);
      }
    },
  );

  // POST /customers/logout — revoke the presented session via the denylist.
  router.post(
    "/customers/logout",
    express.json({ limit: AUTH_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        // Logout REQUIRES an identity: the raw token is revoked, so the bearer
        // token must be present and valid. Never a client-supplied identity.
        const resolved = await resolveActorAndTokenFromBearerToken(
          req,
          deps.tokenService,
        );
        if (!resolved) {
          throw new DomainError(
            "UNAUTHORIZED_ACCESS",
            "Authentication required.",
          );
        }

        // Optional body: ONLY { reason } for the audit trail.
        const body =
          req.body === undefined || req.body === null
            ? {}
            : parseStrictBodyObject(req.body, LOGOUT_BODY_KEYS);
        const reason =
          typeof body.reason === "string" && body.reason.trim()
            ? body.reason.trim()
            : undefined;

        await deps.revokeCustomerSession.execute({
          activeToken: resolved.rawToken,
          actorId: resolved.customerId,
          reason,
        });

        res.status(204).end();
      } catch (err: unknown) {
        const mapped = mapDomainErrorToHttp(err);
        deps.logger.warn("Session revocation rejected", {
          status: mapped.status,
          code: mapped.code,
        });
        sendErrorResponse(res, mapped);
      }
    },
  );

  // express.json errors (malformed body, oversized payload) never reach the
  // route handlers; map them to the standard envelope.
  router.use(createBodyParseErrorHandler(deps.logger, "Auth"));

  return router;
}
