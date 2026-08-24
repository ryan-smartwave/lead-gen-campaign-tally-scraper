#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Applies db/migrations/*.sql in filename order, once each, inside a
 * transaction. Deliberately ~60 lines of plain SQL runner rather than an ORM
 * with a codegen step: there are a handful of tables and one maintainer.
 *
 * Uses a direct (non-pooled) connection, which is what DDL wants.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, "db", "migrations");

// Load .env.local without a dependency.
for (const name of [".env.local", ".env"]) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (value && !process.env[match[1]]) process.env[match[1]] = value;
  }
}

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL is not set.\n\n" +
      "1. Create a free project at https://neon.com\n" +
      "2. Copy its connection string\n" +
      "3. Put it in web/.env.local as DATABASE_URL=...\n" +
      "4. Run this again.",
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  await client.query(
    `create table if not exists schema_migrations (
       filename text primary key,
       applied_at timestamptz not null default now())`,
  );
  const { rows } = await client.query("select filename from schema_migrations");
  const applied = new Set(rows.map((r) => r.filename));

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let count = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (filename) values ($1)", [file]);
      await client.query("commit");
      console.log(`  apply ${file}`);
      count += 1;
    } catch (err) {
      await client.query("rollback");
      throw new Error(`${file} failed: ${err.message}`);
    }
  }

  console.log(count === 0 ? "Database already up to date." : `Applied ${count} migration(s).`);
} finally {
  await client.end();
}
