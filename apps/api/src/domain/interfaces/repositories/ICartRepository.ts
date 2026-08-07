import { Cart } from "@api/domain/entities/Cart";

export interface ICartRepository {
  findById(cartId: string): Promise<Cart | null>;
  save(cart: Cart): Promise<void>;
  delete(cartId: string): Promise<void>;
  deleteAbandonedCarts(expirationDateThreshold: Date): Promise<number>;
}
