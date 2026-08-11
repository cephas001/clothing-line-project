// apps/api/src/infrastructure/database/connection/kysely.ts
import "dotenv/config";
import { Pool, types } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { Database } from "../schema/types";
import { TransactionContext } from "../transaction/TransactionContext";

// The domain treats monetary values as JS `number` minor units (see
// domain/shared/contracts.ts), but the schema stores them as BIGINT. Parse
// INT8 results back into `number` so repositories never see strings.
// OID 20 = int8.
types.setTypeParser(20, (value) => {
  return value === null ? null : Number(value);
});

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set. See apps/api/.env.example");
}

const dialect = new PostgresDialect({
  pool: new Pool({
    connectionString,
    max: 10, // Limit connection pool size
  }),
});

export const db = new Kysely<Database>({
  dialect,
});

// Shared transaction context: repositories resolve their connection through
// this singleton so calls inside `transactionManager.execute(...)` join the
// active transaction while calls outside it use the pooled connection.
export const transactionContext = new TransactionContext(db);
