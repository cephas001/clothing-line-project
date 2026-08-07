import { BusinessUnitRecord } from "@api/domain/shared/contracts";

export interface IBusinessUnitRepository {
  findByRegistrationNumber(
    registrationNumber: string,
  ): Promise<BusinessUnitRecord | null>;
  findByName(name: string): Promise<BusinessUnitRecord | null>;
  save(businessUnit: BusinessUnitRecord): Promise<void>;
}
