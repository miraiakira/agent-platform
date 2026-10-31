import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";

export async function createTestDatabase() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is required for integration tests");
  const admin = new Pool({ connectionString });
  const schema = `integration_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  async function close() {
    await pool.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const dir = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(name, dir), "utf8"));
    }
    return { pool, close };
  } catch (error) {
    await close();
    throw error;
  }
}
