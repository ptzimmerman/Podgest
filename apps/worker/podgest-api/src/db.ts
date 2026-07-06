/**
 * Minimal helpers around Cloudflare D1 prepared statements.
 *
 * Conventions (see migration/d1_schema.sql):
 * - booleans are INTEGER 0/1
 * - JSON columns are TEXT (JSON.stringify on write, JSON.parse on read)
 * - timestamps are ISO-8601 TEXT strings
 */

/** Fetch the first row of a query, or null if no rows match. */
export async function one<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<T | null> {
  const row = await db.prepare(sql).bind(...binds).first<T>();
  return row ?? null;
}

/** Fetch all rows of a query. */
export async function all<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<T[]> {
  const result = await db.prepare(sql).bind(...binds).all<T>();
  return result.results ?? [];
}

/** Execute a write statement (INSERT/UPDATE/DELETE). Returns D1 metadata (e.g. meta.changes). */
export async function run(
  db: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<D1Response> {
  return db.prepare(sql).bind(...binds).run();
}

/** Parse a TEXT JSON column value, returning fallback on null/invalid JSON. */
export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
