// Diagnostic: how rich are the recorded posts, and what did failed hashtag
// visits say? Read-only. Uses the project's own pool (DATABASE_URL from .env).
import { loadEnv } from "../src/config/env.js";
loadEnv();
const { query } = await import("../src/db/pool.js");

const tallies = await query(
  `select run_id, platform, hashtag, status, posts_on_page, new_posts, message
   from tallies order by run_id desc limit 12`,
);
console.log("--- tallies (newest first) ---");
for (const r of tallies.rows) console.log(JSON.stringify(r));

const cov = await query(
  `select platform, count(*)::int n, count(username)::int has_user,
          count(caption)::int has_cap, count(like_count)::int has_likes,
          count(image_url)::int has_img, count(url)::int has_url,
          count(taken_at)::int has_taken
   from posts group by platform`,
);
console.log("--- posts field coverage ---");
for (const r of cov.rows) console.log(JSON.stringify(r));

const ig = await query(
  `select post_id, url is not null as has_url, username,
          caption is not null as has_cap, like_count,
          image_url is not null as has_img, taken_at
   from posts where platform = 'instagram'
   order by first_seen_at desc limit 8`,
);
console.log("--- recent IG posts ---");
for (const r of ig.rows) console.log(JSON.stringify(r));
process.exit(0);
