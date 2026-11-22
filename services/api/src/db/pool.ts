import pg from "pg";

import { config } from "../config";

// Timestamps travel as ISO strings and dates as written. 64-bit integers stay strings, which is the
// driver's default, so amounts never pass through floating point.
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (value) => new Date(value).toISOString());
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

// An idle connection can drop, for instance when the database restarts. The pool opens a new one for the
// next query; without a listener the error would end the process.
pool.on("error", (error) => console.error("An idle database connection failed", error));

/** Anything that can run a query: the pool, or a client inside a transaction. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

const toCamel = (name: string) => name.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

function camelise<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [toCamel(key), value])) as T;
}

/** Runs a query and returns its rows with camelCase keys. */
export async function query<T = Record<string, unknown>>(
  db: Queryable,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await db.query(text, values);
  return result.rows.map((row) => camelise<T>(row));
}

/** Runs a query that returns at most one row. */
export async function queryOne<T = Record<string, unknown>>(
  db: Queryable,
  text: string,
  values: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(db, text, values);
  return rows[0];
}

export interface TransactionOptions {
  /** Reads only, from one snapshot taken at the first query, so every result describes the same moment. */
  snapshot?: boolean;
}

/** Runs `work` inside a transaction and commits it, or rolls back when it throws. */
export async function transaction<T>(
  work: (client: pg.PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query(options.snapshot ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // A connection that cannot even roll back is discarded instead of going back to the pool.
    await client.query("ROLLBACK").catch((failure: Error) => {
      broken = failure;
    });
    throw error;
  } finally {
    client.release(broken);
  }
}
