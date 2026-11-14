import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { cleanupSteps } from '../scripts/reliability/diagnostics';

export async function createTestDatabase() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is required for integration tests");
  const admin = new Pool({ connectionString, connectionTimeoutMillis:5000, query_timeout:5000 });
  // Fixture maintenance pools must survive an intentional database restart.
  admin.on('error',()=>{});
  const schema = `integration_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis:5000, query_timeout:5000 });
  pool.on('error',()=>{});
  async function close() {
    return cleanupSteps([
      {step:'schema_pool.end',run:()=>pool.end()},
      {step:'schema.drop',run:async()=>{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}},
      {step:'admin_pool.end',run:()=>admin.end()},
    ]);
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const dir = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(name, dir), "utf8"));
    }
    return { pool, close, schema };
  } catch (error) {
    try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Fixture setup and cleanup failed');}
    throw error;
  }
}
