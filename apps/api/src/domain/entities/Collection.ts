// apps/api/src/domain/entities/Collection.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";

export interface CollectionProps {
  id: string;
  title: string;
}

export class Collection {
  readonly id: string;
  private _title: string;

  constructor(props: CollectionProps) {
    if (!props.title || props.title.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Collection title is required.",
      );
    }

    this.id = props.id;
    this._title = props.title;
  }

  // Domain Behavior
  public updateTitle(newTitle: string): void {
    if (!newTitle || newTitle.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Collection title cannot be empty.",
      );
    }
    this._title = newTitle;
  }

  get title(): string {
    return this._title;
  }
}
