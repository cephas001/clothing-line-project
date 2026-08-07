import { Cart } from "@api/domain/entities/Cart";

export interface ITaxCalculationService {
  calculateTaxForAddress(cart: Cart): Promise<number>;
}
