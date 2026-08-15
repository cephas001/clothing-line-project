// apps/api/src/infrastructure/database/repositories/PostgresReturnRepository.ts

// Postgres-backed implementation of IReturnRepository.
//
// Persists ReturnAuthorization aggregate values. The items array is stored as a
// JSONB snapshot; created_at is written explicitly because the aggregate
// carries it.

import type { ReturnAuthorization } from "@api-domain-entities/ReturnAuthorization";
import type { IReturnRepository } from "@api-domain-interfaces/repositories/IReturnRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

export class PostgresReturnRepository implements IReturnRepository {
  constructor(private readonly context: TransactionContext) {}

  async save(returnData: ReturnAuthorization): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("return_authorization")
        .values({
          id: returnData.id,
          order_id: returnData.orderId,
          items: JSON.stringify(returnData.items),
          refund_amount_minor: returnData.refundAmountMinor,
          status: returnData.status,
          shipping_label_url: returnData.shippingLabelUrl,
          provider_shipment_id: returnData.providerShipmentId,
          requested_by_customer_id: returnData.requestedByCustomerId,
          created_by: returnData.createdBy,
          created_at: returnData.createdAt,
          metadata: JSON.stringify(returnData.metadata),
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            order_id: returnData.orderId,
            items: JSON.stringify(returnData.items),
            refund_amount_minor: returnData.refundAmountMinor,
            status: returnData.status,
            shipping_label_url: returnData.shippingLabelUrl,
            provider_shipment_id: returnData.providerShipmentId,
            requested_by_customer_id: returnData.requestedByCustomerId,
            created_by: returnData.createdBy,
            created_at: returnData.createdAt,
            metadata: JSON.stringify(returnData.metadata),
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}