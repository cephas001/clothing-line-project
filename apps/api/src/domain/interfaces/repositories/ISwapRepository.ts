// apps/api/src/domain/interfaces/repositories/ISwapRepository.ts
import { Swap } from "@api-domain-entities/Swap";

export interface ISwapRepository {
  save(swap: Swap): Promise<void>;
  /**
   * Find a swap by its primary key. Used by the swap-payment finalization
   * pipeline to resolve the swap a settled obligation references
   * (`payment.obligationId === swap.id`).
   */
  findById(id: string): Promise<Swap | null>;
  /**
   * Find the swap created for a given request by its deterministic business
   * identity (order + line item + target variant + quantity). Keyed on the
   * UNIQUE `swap.natural_key` column so a re-run of the same swap request
   * resolves the existing swap instead of creating a duplicate.
   */
  findByNaturalKey(naturalKey: string): Promise<Swap | null>;
}