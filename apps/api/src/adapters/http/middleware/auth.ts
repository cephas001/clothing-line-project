// apps/api/src/adapters/http/middleware/auth.ts

// Shared transport-boundary auth helpers (Phase 9): resolve the authenticated
// actor from the `Authorization: Bearer <jwt>` header. Returns undefined for
// guest checkout (no header presented). Throws UNAUTHORIZED_ACCESS for a
// present-but-invalid header or token. A customerId is NEVER read from a
// request body — the JWT is the only identity source. Routers that need the RAW
// token (session revocation) use resolveActorAndTokenFromBearerToken; both
// share the SAME single JWT-verification path so parsing is never duplicated.

import type { Request } from "express";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";

export interface ResolvedActor {
  /** The raw bearer token as presented (used e.g. for denylist revocation). */
  rawToken: string;
  /** The verified customer identity carried by the token. */
  customerId: string;
}

/** Extract the raw bearer token from an Authorization header (scheme-validated). */
function extractBearerToken(authHeader: string): string {
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  const token = match?.[1]?.trim() ?? "";
  if (!match || !token) {
    throw new DomainError(
      "UNAUTHORIZED_ACCESS",
      "Authorization header must use the 'Bearer <token>' scheme.",
    );
  }
  return token;
}

/**
 * Resolve the authenticated actor AND the raw bearer token from the request.
 * undefined when no Authorization header is presented (guest flows); throws
 * UNAUTHORIZED_ACCESS for a present-but-invalid header or token. The single
 * place the transport verifies a JWT.
 */
export async function resolveActorAndTokenFromBearerToken(
  req: Request,
  tokenService: ITokenService,
): Promise<ResolvedActor | undefined> {
  const authHeader = (req.get("authorization") ?? "").trim();
  if (!authHeader) {
    return undefined;
  }
  const rawToken = extractBearerToken(authHeader);
  try {
    const claims = await tokenService.verifyToken(rawToken);
    const customerId =
      typeof claims.customerId === "string" ? claims.customerId.trim() : "";
    if (!customerId) {
      throw new DomainError(
        "UNAUTHORIZED_ACCESS",
        "Authentication token carries no customer identity.",
      );
    }
    return { rawToken, customerId };
  } catch (err: unknown) {
    if (err instanceof DomainError) {
      throw err;
    }
    throw new DomainError(
      "UNAUTHORIZED_ACCESS",
      "Invalid or expired authentication token.",
    );
  }
}

/**
 * Resolve just the authenticated actor's customerId (guest-safe). Thin wrapper
 * over the shared verification path — never parses the JWT twice.
 */
export async function resolveActorFromBearerToken(
  req: Request,
  tokenService: ITokenService,
): Promise<string | undefined> {
  const resolved = await resolveActorAndTokenFromBearerToken(req, tokenService);
  return resolved?.customerId;
}
