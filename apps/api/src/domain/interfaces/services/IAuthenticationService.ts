export interface IAuthorizationService {
  authorizeAdmin(adminId: string, permission: string): Promise<void>;
}
