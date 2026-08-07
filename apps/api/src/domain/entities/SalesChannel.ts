// apps/api/src/domain/entities/SalesChannel.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";

export interface SalesChannelProps {
  id: string;
  name: string;
  description?: string;
  isDisabled?: boolean;
  createdAt: string;
}

export class SalesChannel {
  readonly id: string;
  public name: string;
  public description: string | null;
  private _isDisabled: boolean;
  public createdAt: string;

  constructor(props: SalesChannelProps) {
    if (!props.name || props.name.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Sales channel name is required.",
      );
    }

    this.id = props.id;
    this.name = props.name;
    this.description = props.description || null;
    this._isDisabled = props.isDisabled ?? false;
    this.createdAt = props.createdAt;
  }

  public disable(): void {
    this._isDisabled = true;
  }

  public enable(): void {
    this._isDisabled = false;
  }

  get isDisabled(): boolean {
    return this._isDisabled;
  }
}
