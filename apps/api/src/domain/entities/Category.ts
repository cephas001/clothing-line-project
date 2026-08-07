// apps/api/src/domain/entities/Category.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";

export interface CategoryProps {
  id: string;
  name: string;
  parentCategoryId?: string | null;
  createdAt: string;
}

export class Category {
  readonly id: string;
  public name: string;
  public parentCategoryId: string | null;
  public createdAt: string;

  constructor(props: CategoryProps) {
    if (!props.name || props.name.trim() === "") {
      throw new DomainError("VALIDATION_ERROR", "Category name is required.");
    }

    this.id = props.id;
    this.name = props.name;
    this.parentCategoryId = props.parentCategoryId || null;
    this.createdAt = props.createdAt;
  }

  // Domain Behavior: Tree structure management
  public setParent(parentId: string | null): void {
    if (this.id === parentId) {
      throw new DomainError(
        "INVALID_OPERATION",
        "A category cannot be its own parent.",
      );
    }
    this.parentCategoryId = parentId;
  }
}
