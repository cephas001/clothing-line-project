// apps/api/src/domain/interfaces/shared/ITransactionManager.ts

/**
 * Defines an atomic unit of work boundary for the application layer.
 *
 * The application layer depends only on this abstraction. Orchestrating
 * multiple repository mutations within a single business operation must be
 * delegated to this manager; repositories never own transaction orchestration.
 *
 * Implementations (infrastructure concern) are responsible for opening,
 * committing, and rolling back the underlying database transaction.
 */
export interface ITransactionManager {
  execute<T>(work: () => Promise<T>): Promise<T>;
}