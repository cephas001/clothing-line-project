// apps/api/src/domain/interfaces/repositories/IMoneyAmountRepository.ts

import { MoneyAmount } from "@api/domain/entities/MoneyAmount";

// Abstract interface to be implemented by the Data Layer
export interface IMoneyAmountRepository {
  findById(id: string): Promise<MoneyAmount | null>;

  findRegionalPrice(
    variantId: string,
    regionId: string,
  ): Promise<MoneyAmount | null>;

  save(moneyAmount: MoneyAmount): Promise<void>;
}
