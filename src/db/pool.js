import fs from "node:fs";
import path from "node:path";
import pg from "pg";

/**
 * Postgres access for the service.
 *
 * A pool, not a per-query connection: the service is a long-lived local process,
 * so it keeps connections warm rather than paying a handshake per write during a
 * run.
 *
 * Created lazily. A missing DATABASE_URL must not stop the process from
 * starting — the service still answers /health and can explain itself, and the
 * CLI path needs no database at all.
 */

let pool = null;

export function isDbConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export function db() {
  if (!isDbConfigured()) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      // A sleeping free-tier database can take a moment to wake.
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 30_000,
    });
    // A pool error must never take the process down mid-run.
    pool.on("error", () => {});
  }
  return pool;
}

export function requireDb() {
  const p = db();
  if (!p) {
    const err = new Error(
      "DATABASE_URL is not set. The service stores results in Postgres; put a connection string in .env and restart.",
    );
    err.code = "DB_NOT_CONFIGURED";
    throw err;
  }
  return p;
}

export async function query(text, params = []) {
  return requireDb().query(text, params);
}

export async function closeDb() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
}

/** Loads .env next to the scraper, without adding a dependency. */
export function loadEnv(root) {
  for (const name of [".env", ".env.local"]) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, "");
      if (value && !process.env[m[1]]) process.env[m[1]] = value;
    }
  }
}
