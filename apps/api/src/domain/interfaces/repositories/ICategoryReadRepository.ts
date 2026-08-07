import { Category } from "@api/domain/entities/Category";

export interface ICategoryReadRepository {
  getTree(options: { includeDescendants: boolean }): Promise<Category[]>;
}
