import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createPool } from "./db";

const pool = createPool();

const migrationDir = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

async function migrate() {
  const client = await pool.connect();

  try {
    // 使用会话级 Advisory Lock，避免并发迁移。
    await client.query(
      "SELECT pg_advisory_lock($1)",
      [714006],
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationDir))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const existing = await client.query(
        `SELECT 1 FROM schema_migrations
         WHERE version = $1`,
        [file],
      );

      if (existing.rowCount) {
        continue;
      }

      const sql = await readFile(
        path.join(migrationDir, file),
        "utf8",
      );

      await client.query("BEGIN");

      try {
        await client.query(sql);

        await client.query(
          `INSERT INTO schema_migrations (version)
           VALUES ($1)`,
          [file],
        );

        await client.query("COMMIT");

        console.log(`Applied: ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await client.query(
        "SELECT pg_advisory_unlock($1)",
        [714006],
      );
    } finally {
      client.release();
    }
  }
}

try {
  await migrate();
} finally {
  await pool.end();
}