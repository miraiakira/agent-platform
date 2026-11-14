import {assertFaultSafety} from "./reliability";
import {boundedInteger} from "./limits";
import { Pool } from "pg";

export function createPool(
  connectionString = process.env.DATABASE_URL,
): Pool {
  assertFaultSafety();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  return new Pool({
    connectionString,
    max: boundedInteger("PG_POOL_MAX",10,1,32),
    statement_timeout: boundedInteger("PG_STATEMENT_TIMEOUT_MS",10000,100,60000),
    idle_in_transaction_session_timeout: 15000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}