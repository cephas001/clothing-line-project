// apps/api/tests/fakes/InMemoryQuoteRepository.ts
//
// In-memory IQuoteRepository keyed by quote id. Supports the Snapshotable
// contract so the rollback/atomicity tests (outbox-migrated producers) can
// verify the quote approval + notification intent commit together.

import { Quote } from "@api/domain/entities/Quote";
import type { IQuoteRepository } from "@api/domain/interfaces/repositories/IQuoteRepository";
import type { Snapshotable } from "./cloneEntity";
import { cloneValue } from "./cloneEntity";

export class InMemoryQuoteRepository implements IQuoteRepository, Snapshotable {
  private readonly quotes = new Map<string, Quote>();

  seed(quote: Quote): void {
    this.quotes.set(quote.id, quote);
  }

  get all(): Quote[] {
    return [...this.quotes.values()];
  }

  async save(quote: Quote): Promise<void> {
    this.quotes.set(quote.id, quote);
  }

  async findById(quoteId: string): Promise<Quote | null> {
    return this.quotes.get(quoteId) ?? null;
  }

  snapshot(): unknown {
    return cloneValue([...this.quotes.values()]);
  }

  restore(state: unknown): void {
    this.quotes.clear();
    for (const quote of state as Quote[]) {
      this.quotes.set(quote.id, quote);
    }
  }
}