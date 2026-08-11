// apps/api/src/domain/interfaces/repositories/ISwapRepository.ts
import { Swap } from "@api-domain-entities/Swap";

export interface ISwapRepository {
  save(swap: Swap): Promise<void>;
}