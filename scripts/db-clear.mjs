#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Empties the collected data (runs, tallies, posts) while leaving the schema and
 * the business list in place. Use to start a campaign's numbers over.
 *
 * The scraper's own files are untouched, so nothing is truly lost — a sync will
 * put it all back. Pass --with-businesses to clear those too.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const line of fs.readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const withBusinesses = process.argv.includes("--with-businesses");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  // posts and tallies cascade from runs, but delete explicitly so the counts
  // reported below are honest.
  for (const table of ["posts", "tallies", "runs"]) {
    const res = await client.query(`delete from ${table}`);
    console.log(`  cleared ${res.rowCount} row(s) from ${table}`);
  }
  if (withBusinesses) {
    const res = await client.query("delete from businesses");
    console.log(`  cleared ${res.rowCount} business row(s)`);
  }
  console.log(
    "\nDone. The scraper's local files are untouched — POST /api/sync (or the" +
      "\nSync button) restores everything.",
  );
} finally {
  await client.end();
}
