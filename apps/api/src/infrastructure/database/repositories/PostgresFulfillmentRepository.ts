// apps/api/src/infrastructure/database/repositories/PostgresFulfillmentRepository.ts

// Postgres-backed implementation of IFulfillmentRepository.
//
// Persists FulfillmentRecord records (dispatch + courier tracking). The
// contract only guarantees id/orderId/trackingNumber, so the remaining schema
// columns (courier, label_url, service_level, status, metadata) are written
// defensively when present on the record and read back as optional fields.
// `status` carries the dispatch lifecycle (see DispatchState in
// domain/shared/dispatchStateMachine) and defaults to "dispatch_pending" on
// insert when omitted. created_at is a DB default; updated_at is regenerated
// on every write.

import type {
  FulfillmentRecord,
  JsonObject,
} from "@api/domain/shared/contracts";
import type { IFulfillmentRepository } from "@api-domain-interfaces/repositories/IFulfillmentRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type FulfillmentRow = {
  id: string;
  order_id: string;
  tracking_number: string;
  courier: string | null;
  label_url: string | null;
  service_level: string | null;
  status: string;
  metadata: unknown;
  provider_shipment_id: string | null;
  created_at: string;
  updated_at: string;
};

function strField(
  record: FulfillmentRecord,
  key: string,
): string | null {
  const value = (record as JsonObject)[key];
  return typeof value === "string" ? value : null;
}

function objField(record: FulfillmentRecord): JsonObject | null {
  const value = record.metadata;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function toDomain(row: FulfillmentRow): FulfillmentRecord {
  const record: FulfillmentRecord = {
    id: row.id,
    orderId: row.order_id,
    trackingNumber: row.tracking_number,
  };
  if (row.courier) record.courier = row.courier;
  if (row.label_url) record.labelUrl = row.label_url;
  if (row.service_level) record.serviceLevel = row.service_level;
  if (row.status) record.status = row.status;
  if (row.created_at) record.createdAt = row.created_at;
  if (row.updated_at) record.updatedAt = row.updated_at;
  if (row.provider_shipment_id) record.providerShipmentId = row.provider_shipment_id;
  if (row.metadata && typeof row.metadata === "object") {
    record.metadata = row.metadata as JsonObject;
  }
  return record;
}

export class PostgresFulfillmentRepository implements IFulfillmentRepository {
  constructor(private readonly context: TransactionContext) {}

  async findByTrackingNumber(
    trackingNumber: string,
  ): Promise<FulfillmentRecord | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("fulfillment")
        .selectAll()
        .where("tracking_number", "=", trackingNumber)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByProviderShipmentId(
    providerShipmentId: string,
  ): Promise<FulfillmentRecord | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("fulfillment")
        .selectAll()
        .where("provider_shipment_id", "=", providerShipmentId)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(fulfillment: FulfillmentRecord): Promise<void> {
    try {
      const courier = strField(fulfillment, "courier");
      const labelUrl = strField(fulfillment, "labelUrl");
      const serviceLevel = strField(fulfillment, "serviceLevel");
      const status = strField(fulfillment, "status") ?? "dispatch_pending";
      const providerShipmentId = strField(fulfillment, "providerShipmentId");
      const metadata = objField(fulfillment);

      await this.context
        .getDb()
        .insertInto("fulfillment")
        .values({
          id: fulfillment.id,
          order_id: fulfillment.orderId,
          tracking_number: fulfillment.trackingNumber,
          courier,
          label_url: labelUrl,
          service_level: serviceLevel,
          status,
          provider_shipment_id: providerShipmentId,
          metadata: JSON.stringify(metadata ?? {}),
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            order_id: fulfillment.orderId,
            tracking_number: fulfillment.trackingNumber,
            courier,
            label_url: labelUrl,
            service_level: serviceLevel,
            status,
            provider_shipment_id: providerShipmentId,
            metadata: JSON.stringify(metadata ?? {}),
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
