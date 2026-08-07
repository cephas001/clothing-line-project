export interface IReviewRepository {
  createReview(
    productId: string,
    customerId: string,
    rating: number,
    comment: string | null,
  ): Promise<void>;
  save(review: {
    id: string;
    productId: string;
    customerId: string;
    rating: number;
    comment: string | null;
    createdAt: string;
  }): Promise<void>;
}
