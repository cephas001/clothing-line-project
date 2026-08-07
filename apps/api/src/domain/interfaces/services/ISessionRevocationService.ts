export interface ISessionRevocationService {
  revokeSessionsForUser(userId: string): Promise<void>;
  revokeToken(token: string): Promise<void>;
  listActiveTokensForUser(userId: string): Promise<string[]>;
}
