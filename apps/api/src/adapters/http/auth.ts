// apps/api/src/adapters/http/auth.ts

// Shared transport-boundary helper: resolve the authenticated actor from the
// `Authorization: Bearer <jwt>` header. Returns undefined for guest checkout
// (no header presented). Throws UNAUTHORIZED_ACCESS for a present-but-invalid
// header or token. A customerId is NEVER read from a request body — the JWT is
// the only identity source.

import type { Request } from "express";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";

export async function resolveActorFromBearerToken(
  req: Request,
  tokenService: ITokenService,
): Promise<string | undefined> {
  const authHeader = (req.get("authorization") ?? "").trim();
  if (!authHeader) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  const token = match?.[1]?.trim() ?? "";
  if (!match || !token) {
    throw new DomainError(
      "UNAUTHORIZED_ACCESS",
      "Authorization header must use the 'Bearer <token>' scheme.",
    );
  }
  try {
    const claims = await tokenService.verifyToken(token);
    const customerId =
      typeof claims.customerId === "string" ? claims.customerId.trim() : "";
    if (!customerId) {
      throw new DomainError(
        "UNAUTHORIZED_ACCESS",
        "Authentication token carries no customer identity.",
      );
    }
    return customerId;
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
