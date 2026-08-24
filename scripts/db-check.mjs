#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Diagnostic read-back. Runs the same queries lib/dbStore.ts uses, so it also
 * verifies the ::text date casts (a bare Postgres `date` comes back as a JS
 * Date in UTC, which would render the Manila campaign day as the day before).
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const line of fs.readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const runs = await client.query(
    `select id, campaign, started_at, campaign_day::text as day, status, targets
       from runs order by id desc`,
  );
  console.log("\n== runs (as dbStore reads them) ==");
  console.table(runs.rows.map((r) => ({ id: r.id, day: r.day, status: r.status })));

  const tallies = await client.query(
    `select run_id, campaign_day::text as day, platform, hashtag,
            posts_on_page, new_posts, cumulative_unique, status
       from tallies order by new_posts desc`,
  );
  console.log("\n== tallies ==");
  console.table(
    tallies.rows.map((r) => ({
      day: r.day,
      platform: r.platform,
      hashtag: r.hashtag,
      onPage: r.posts_on_page,
      new: r.new_posts,
      cumulative: r.cumulative_unique,
      status: r.status,
    })),
  );

  const posts = await client.query(
    `select platform, hashtag, post_id, url, preview, author, body
       from posts where platform = 'instagram' and hashtag = 'weddingsph'
       order by first_seen_at desc, post_id desc limit 2`,
  );
  console.log("\n== sample instagram posts ==");
  for (const p of posts.rows) {
    console.log(`  ${p.post_id}  ${p.url}`);
    console.log(`    caption: ${(p.preview ?? "(none)").replace(/\s+/g, " ").slice(0, 100)}`);
  }

  const fb = await client.query(
    `select post_id, author, body from posts where platform = 'facebook' limit 2`,
  );
  console.log("\n== sample facebook posts (no url by design) ==");
  for (const p of fb.rows) {
    console.log(`  ${p.post_id}  author=${p.author ?? "null"}`);
    console.log(`    text: ${(p.body ?? "").replace(/\s+/g, " ").slice(0, 90)}`);
  }

  const totals = await client.query(
    `select count(*) as rows, count(distinct post_id) as distinct_posts from posts`,
  );
  console.log("\n== totals ==");
  console.log(
    `  ${totals.rows[0].rows} tallied rows across hashtags, ${totals.rows[0].distinct_posts} distinct posts`,
  );

  const cfg = await client.query(`select value from app_meta where key = 'config_snapshot'`);
  const hashtags = cfg.rows[0]?.value?.hashtags ?? [];
  console.log(`  config snapshot: ${hashtags.length} configured hashtags`);
} finally {
  await client.end();
}
