// apps/api/tests/fakes/FakeTokenService.ts

// ITokenService fake for the transport-boundary tests. Only verifyToken is
// exercised by the payment-initialization router (actor resolution from the
// bearer JWT); remaining token operations throw to prove they are never
// reached in these flows.

import type {
  PasswordResetTokenClaims,
  PasswordResetTokenIssueResult,
  TokenClaims,
} from "@api/domain/shared/contracts";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import { DomainError } from "@api/domain/entities/errors/DomainError";

export class FakeTokenService implements ITokenService {
  constructor(
    private readonly claimsByToken: Map<string, TokenClaims> = new Map(),
  ) {}

  async verifyToken(token: string): Promise<TokenClaims> {
    const claims = this.claimsByToken.get(token);
    if (!claims) {
      throw new DomainError("UNAUTHORIZED_ACCESS", "Invalid or expired token.");
    }
    return claims;
  }

  async generateAuthToken(): Promise<string> {
    throw new Error("FakeTokenService.generateAuthToken is not implemented.");
  }

  async generatePasswordResetToken(): Promise<
    string | PasswordResetTokenIssueResult
  > {
    throw new Error("FakeTokenService.generatePasswordResetToken is not implemented.");
  }

  async hashToken(): Promise<string> {
    throw new Error("FakeTokenService.hashToken is not implemented.");
  }

  async verifyPasswordResetToken(): Promise<PasswordResetTokenClaims> {
    throw new Error("FakeTokenService.verifyPasswordResetToken is not implemented.");
  }

  async verifyTokenHash(): Promise<boolean> {
    throw new Error("FakeTokenService.verifyTokenHash is not implemented.");
  }

  async revokePasswordResetToken(): Promise<void> {
    throw new Error("FakeTokenService.revokePasswordResetToken is not implemented.");
  }

  async revokeToken(): Promise<void> {
    throw new Error("FakeTokenService.revokeToken is not implemented.");
  }
}