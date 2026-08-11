// apps/api/src/infrastructure/database/repositories/PostgresReviewRepository.ts

// Postgres-backed implementation of IReviewRepository.
//
// Persists product reviews. created_at is a DB default; save() writes it
// explicitly because the caller supplies it, while createReview() (which has
// no id/createdAt) generates an id and relies on the DB default timestamp.
// Note: the schema has no uniqueness constraint on (product_id, customer_id),
// so duplicate-review detection is left to the caller's business logic.

import { randomUUID } from "node:crypto";
import type { IReviewRepository } from "@api-domain-interfaces/repositories/IReviewRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type ReviewInput = {
  id: string;
  productId: string;
  customerId: string;
  rating: number;
  comment: string | null;
  createdAt: string;
};

export class PostgresReviewRepository implements IReviewRepository {
  constructor(private readonly context: TransactionContext) {}

  async createReview(
    productId: string,
    customerId: string,
    rating: number,
    comment: string | null,
  ): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("review")
        .values({
          id: randomUUID(),
          product_id: productId,
          customer_id: customerId,
          rating,
          comment,
        })
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(review: ReviewInput): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("review")
        .values({
          id: review.id,
          product_id: review.productId,
          customer_id: review.customerId,
          rating: review.rating,
          comment: review.comment,
          created_at: review.createdAt,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            product_id: review.productId,
            customer_id: review.customerId,
            rating: review.rating,
            comment: review.comment,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
