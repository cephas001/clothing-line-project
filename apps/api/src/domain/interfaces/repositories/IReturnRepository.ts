import { ReturnAuthorization } from "@api/domain/entities/ReturnAuthorization";

export interface IReturnRepository {
  save(returnAuthorization: ReturnAuthorization): Promise<void>;
}
