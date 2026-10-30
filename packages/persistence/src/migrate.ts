import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool } from "./db";

const pool = createPool();

try {
  const path = fileURLToPath(
    new URL("../migrations/001_initial.sql", import.meta.url),
  );

  const sql = await readFile(path, "utf8");

  await pool.query(sql);
  console.log("Migration 001 applied");
} finally {
  await pool.end();
}