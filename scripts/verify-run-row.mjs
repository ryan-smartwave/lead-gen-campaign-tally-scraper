#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Proves the run row a service-driven scrape opens with is actually accepted.
 *
 * This exists because it wasn't: `source = 'service'` violated a check
 * constraint that only allowed web/cli/import, so the first database write of
 * every run failed — and the rejection took the whole service down. Migration
 * 003 widened the constraint; this asserts it, and that the older values still
 * work, inside a transaction that is rolled back.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const name of [".env", ".env.local"]) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, name), "utf8");
  } catch {
    continue;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const BIZ = "__runrow_verify__";
try {
  await client.query("begin");
  await client.query(
    `insert into businesses (slug, name, hashtags) values ($1,$2,'[]'::jsonb)
     on conflict (slug) do nothing`,
    [BIZ, "Run row verification"],
  );

  for (const source of ["service", "cli", "import", "web"]) {
    const id = `2000-01-01T00:00:0${["service", "cli", "import", "web"].indexOf(source)}.000Z`;
    try {
      await client.query(
        `insert into runs (id, business, campaign, started_at, campaign_day, status,
                           budget_minutes, targets, source, imported)
         values ($1,$2,'Run row verification',$3,$4,'complete',60,'[]'::jsonb,$5,false)`,
        [id, BIZ, id, "2000-01-01", source],
      );
      check(`source '${source}' is accepted`, true);
    } catch (err) {
      check(`source '${source}' is accepted`, false, err.message);
    }
  }

  // And a value that should still be refused, so the constraint isn't just gone.
  try {
    await client.query(
      `insert into runs (id, business, campaign, started_at, campaign_day, status, targets, source)
       values ('2000-01-02T00:00:00.000Z',$1,'x','2000-01-02','2000-01-02','complete','[]'::jsonb,'nonsense')`,
      [BIZ],
    );
    check("an unknown source is still refused", false, "it was accepted");
  } catch {
    check("an unknown source is still refused", true);
  }
} catch (err) {
  failures += 1;
  console.error(`  FAIL threw: ${err.message}`);
} finally {
  await client.query("rollback").catch(() => {});
  await client.end();
}

console.log(failures ? "\nrun row verification FAILED" : "\nrun row verification passed (rolled back)");
process.exit(failures ? 1 : 0);
