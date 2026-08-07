import {
  PasswordResetTokenIssueResult,
  PasswordResetTokenClaims,
  TokenClaims,
} from "@api/domain/shared/contracts";

export interface ITokenService {
  generateAuthToken(
    payload: TokenClaims,
    expiresIn?: string | number,
  ): Promise<string>;
  verifyToken(token: string): Promise<TokenClaims>;
  generatePasswordResetToken(
    customerId: string,
    options?: { ttlSeconds?: number },
  ): Promise<string | PasswordResetTokenIssueResult>;
  hashToken(token: string): Promise<string>;
  verifyPasswordResetToken(token: string): Promise<PasswordResetTokenClaims>;
  verifyTokenHash(token: string, hash: string): Promise<boolean>;
  revokePasswordResetToken(userId: string): Promise<void>;
  revokeToken(token: string): Promise<void>;
}
