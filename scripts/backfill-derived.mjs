// One-time backfill of derived fields on existing posts rows:
//   - other_hashtags: parsed from stored caption/body/preview text
//     (src/utils/hashtags.js — the same extractor live runs use)
//   - url: derived from a DOM-harvested fbid for Facebook rows that have an
//     fbid-shaped post_id but never matched a captured story
//     (capture.service.fbUrlFromPostId)
// Read-modify-write over the project's own pool; safe to re-run (idempotent).
import { loadEnv } from "../src/config/env.js";
loadEnv();
const { query } = await import("../src/db/pool.js");
const { extractOtherHashtags } = await import("../src/utils/hashtags.js");
const { fbUrlFromPostId } = await import("../src/services/capture.service.js");

const { rows } = await query(
  `select business, platform, hashtag, post_id, url, caption, body, preview, other_hashtags
   from posts`,
);

let tagged = 0;
let linked = 0;
for (const r of rows) {
  const tags = extractOtherHashtags(
    [r.caption, r.body, r.preview].filter(Boolean).join(" "),
    r.hashtag,
  );
  const newTags = !r.other_hashtags && tags.length ? tags : null;
  const newUrl = r.platform === "facebook" && !r.url ? fbUrlFromPostId(r.post_id) : null;
  if (!newTags && !newUrl) continue;
  await query(
    `update posts set
       other_hashtags = coalesce($5, other_hashtags),
       url            = coalesce($6, url)
     where business = $1 and platform = $2 and hashtag = $3 and post_id = $4`,
    [r.business, r.platform, r.hashtag, r.post_id, newTags, newUrl],
  );
  if (newTags) tagged++;
  if (newUrl) linked++;
}

console.log(`backfilled other_hashtags on ${tagged} row(s), derived urls on ${linked} row(s) of ${rows.length}`);
process.exit(0);
