// apps/api/tests/fakes/InMemoryFulfillmentRepository.ts
import type { IFulfillmentRepository } from "@api/domain/interfaces/repositories/IFulfillmentRepository";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { FulfillmentRecord } from "@api/domain/shared/contracts";

/**
 * In-memory fulfillment store mirroring the dispatch claim semantics of the
 * migration-0011 partial-unique index: at most ONE fulfillment row may claim a
 * given order. Saving a NEW id for an already-claimed order raises DUPLICATE —
 * exactly the race DispatchOrderFulfillmentUseCase resolves without ever
 * re-POSTing to the provider. Re-saving the SAME id reconciles in place (the
 * use case's `updated` record), which is how dispatch state advances.
 */
export class InMemoryFulfillmentRepository implements IFulfillmentRepository {
  private readonly fulfillments = new Map<string, FulfillmentRecord>();
  failNextSaveWith?: RepositoryErrorCode;

  seed(record: FulfillmentRecord): void {
    this.fulfillments.set(record.id, record);
  }

  get all(): FulfillmentRecord[] {
    return [...this.fulfillments.values()];
  }

  async save(record: FulfillmentRecord): Promise<void> {
    if (this.failNextSaveWith) {
      const code = this.failNextSaveWith;
      this.failNextSaveWith = undefined;
      throw this.repositoryError(code, "Injected repository failure.");
    }

    if (this.fulfillments.has(record.id)) {
      this.fulfillments.set(record.id, record);
      return;
    }

    const claimed = [...this.fulfillments.values()].some(
      (existing) => existing.orderId === record.orderId,
    );
    if (claimed) {
      throw this.repositoryError(
        RepositoryErrorCode.DUPLICATE,
        `Dispatch claim already exists for order ${record.orderId}.`,
      );
    }

    this.fulfillments.set(record.id, record);
  }

  async findByTrackingNumber(trackingNumber: string): Promise<FulfillmentRecord | null> {
    const normalized = trackingNumber.trim();
    for (const record of this.fulfillments.values()) {
      if ((record.trackingNumber ?? "").trim() === normalized) return record;
    }
    return null;
  }

  async findByProviderShipmentId(providerShipmentId: string): Promise<FulfillmentRecord | null> {
    const normalized = providerShipmentId.trim();
    for (const record of this.fulfillments.values()) {
      if ((record.providerShipmentId ?? "").trim() === normalized) return record;
    }
    return null;
  }

  private repositoryError(code: RepositoryErrorCode, message: string): RepositoryError {
    const error = new Error(message) as RepositoryError;
    error.name = "RepositoryError";
    error.code = code;
    return error;
  }
}