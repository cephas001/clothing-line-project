import { Quote } from "@api/domain/entities/Quote";

export interface IQuoteRepository {
  save(quote: Quote): Promise<void>;
  findById(quoteId: string): Promise<Quote | null>;
}
