import { ReturnAuthorization } from "@api/domain/entities/ReturnAuthorization";

export interface IReturnRepository {
  save(returnData: ReturnAuthorization): Promise<void>;
}
