// apps/api/src/domain/entities/Quote.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";

export type QuoteStatus = "PENDING_APPROVAL" | "APPROVED" | "REJECTED";

export interface QuoteProps {
  id: string;
  cartId: string;
  cartSnapshotJson: string;
  businessUnitId: string;
  requestedByCustomerId: string;
  requestedAt: string;
  status?: QuoteStatus;
  notes?: string | null;
  approvedTotalMinor?: number | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  approvalNote?: string | null;
}

export interface QuoteApprovalProps {
  approvedBy: string;
  approvedTotalMinor: number;
  approvedAt?: string;
  note?: string | null;
}

export class Quote {
  readonly id: string;
  readonly cartId: string;
  readonly cartSnapshotJson: string;
  readonly businessUnitId: string;
  readonly requestedByCustomerId: string;
  readonly requestedAt: string;

  private _status: QuoteStatus;
  private _notes: string | null;
  private _approvedTotalMinor: number | null;
  private _approvedBy: string | null;
  private _approvedAt: string | null;
  private _approvalNote: string | null;

  constructor(props: QuoteProps) {
    if (!props.cartId.trim()) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }
    if (!props.businessUnitId.trim()) {
      throw new DomainError("VALIDATION_ERROR", "businessUnitId is required.");
    }
    if (!props.requestedByCustomerId.trim()) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "requestedByCustomerId is required.",
      );
    }
    if (!props.cartSnapshotJson.trim()) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "cartSnapshotJson is required.",
      );
    }
    try {
      JSON.parse(props.cartSnapshotJson);
    } catch {
      throw new DomainError(
        "VALIDATION_ERROR",
        "cartSnapshotJson must be valid JSON.",
      );
    }

    this.id = props.id;
    this.cartId = props.cartId;
    this.cartSnapshotJson = props.cartSnapshotJson;
    this.businessUnitId = props.businessUnitId;
    this.requestedByCustomerId = props.requestedByCustomerId;
    this.requestedAt = props.requestedAt;
    this._status = props.status ?? "PENDING_APPROVAL";
    this._notes = props.notes ?? null;
    this._approvedTotalMinor = props.approvedTotalMinor ?? null;
    this._approvedBy = props.approvedBy ?? null;
    this._approvedAt = props.approvedAt ?? null;
    this._approvalNote = props.approvalNote ?? null;
  }

  public approve(props: QuoteApprovalProps): void {
    if (this._status !== "PENDING_APPROVAL") {
      throw new DomainError(
        "INVALID_STATE",
        "Only pending quotes can be approved.",
      );
    }

    if (!props.approvedBy.trim()) {
      throw new DomainError("VALIDATION_ERROR", "approvedBy is required.");
    }
    if (
      !Number.isFinite(props.approvedTotalMinor) ||
      props.approvedTotalMinor < 0
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "approvedTotalMinor must be a non-negative number.",
      );
    }

    this._status = "APPROVED";
    this._approvedBy = props.approvedBy;
    this._approvedTotalMinor = Math.floor(props.approvedTotalMinor);
    this._approvedAt = props.approvedAt ?? new Date().toISOString();
    this._approvalNote = props.note ?? null;
  }

  get status(): QuoteStatus {
    return this._status;
  }

  get notes(): string | null {
    return this._notes;
  }

  get approvedTotalMinor(): number | null {
    return this._approvedTotalMinor;
  }

  get approvedBy(): string | null {
    return this._approvedBy;
  }

  get approvedAt(): string | null {
    return this._approvedAt;
  }

  get approvalNote(): string | null {
    return this._approvalNote;
  }

  public toJSON(): QuoteProps {
    return {
      id: this.id,
      cartId: this.cartId,
      cartSnapshotJson: this.cartSnapshotJson,
      businessUnitId: this.businessUnitId,
      requestedByCustomerId: this.requestedByCustomerId,
      requestedAt: this.requestedAt,
      status: this._status,
      notes: this._notes,
      approvedTotalMinor: this._approvedTotalMinor,
      approvedBy: this._approvedBy,
      approvedAt: this._approvedAt,
      approvalNote: this._approvalNote,
    };
  }
}
