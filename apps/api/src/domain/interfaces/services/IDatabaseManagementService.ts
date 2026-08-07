import { DatabaseTerminationResult } from "@api/domain/shared/contracts";

export interface IDatabaseManagementService {
  terminateStaleTransactions(
    staleThresholdMs: number,
  ): Promise<number | DatabaseTerminationResult | DatabaseTerminationResult[]>;
}
