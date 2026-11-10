/**
 * Applies the SQL migrations in `migrations/` in file-name order, each in its own transaction.
 * A migration that has been applied is never run again.
 *
 *   pnpm --filter @takarail/api migrate
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pool, query, transaction } from "./pool";

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  const applied = new Set(
    (await query<{ name: string }>(pool, "SELECT name FROM schema_migrations")).map((row) => row.name),
  );

  const pending = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".sql") && !applied.has(file))
    .sort();

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(directory, file), "utf8");
    await transaction(async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
  }
  return pending;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate()
    .then((files) => console.log(files.length ? `Applied: ${files.join(", ")}` : "Schema is up to date"))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
