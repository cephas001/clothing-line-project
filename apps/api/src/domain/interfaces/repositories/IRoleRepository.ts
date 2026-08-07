// apps/api/src/domain/interfaces/repositories/IRoleRepository.ts

import { Role } from "@api-domain-entities/Role";

// Abstract interface to be implemented by the Data Layer
export interface IRoleRepository {
  findById(id: string): Promise<Role | null>;

  save(role: Role): Promise<void>;
}
