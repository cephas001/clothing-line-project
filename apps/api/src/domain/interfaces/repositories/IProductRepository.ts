import { Product } from "@api-domain-entities/Product";

// Abstract interface to be implemented by the Data Layer
export interface IProductRepository {
  findByHandle(handle: string): Promise<Product | null>;
  save(product: Product): Promise<void>;
  findById(id: string): Promise<Product | null>;
}
