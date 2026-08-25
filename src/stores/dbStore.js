import { query, requireDb } from "../db/pool.js";
import { campaignDay } from "../utils/day.js";
import { countFresh, toIso } from "../utils/freshness.js";

/**
 * A run store backed entirely by Postgres. Writes no results to disk.
 *
 * Deduplication comes from the same place the results do, which is the point:
 * `newCount` is however many post rows the insert actually created, and
 * `cumulative` is the row count for that hashtag afterwards. Both derive from
 * the posts table rather than a local file that could drift out of step.
 *
 * The grain is (business, platform, hashtag, post_id). A post carrying several
 * campaign hashtags counts under each — matching the file-backed store — and two
 * businesses tracking the same hashtag stay independent.
 */
export function createDbStore({ business, campaign, runId, budgetMinutes, targets }) {
  requireDb();
  const day = campaignDay(runId);

  // Opens the run row. Awaited before any write, so the foreign key exists.
  //
  // This promise starts eagerly, so if it rejects with nothing yet awaiting it
  // Node reports an unhandled rejection and tears the process down — which is
  // exactly how a single bad constraint once killed the whole service. The
  // no-op catch below marks it handled; every `await ready` still rejects
  // normally, so failures surface to the caller instead of the process.
  const ready = (async () => {
    // The lock guarantees no other run is live, so a row still marked running
    // belongs to a crashed process and can be closed out.
    await query(
      `update runs set status = 'aborted', abort_reason = 'process ended without finishing',
                       finished_at = now()
       where status = 'running'`,
    );
    await query(
      `insert into runs (id, business, campaign, started_at, campaign_day, status,
                         budget_minutes, targets, source, imported)
       values ($1,$2,$3,$4,$5,'running',$6,$7::jsonb,'service',false)
       on conflict (id) do update set
         status = 'running', business = excluded.business, targets = excluded.targets`,
      [runId, business, campaign, runId, day, budgetMinutes, JSON.stringify(targets)],
    );
  })();
  ready.catch(() => {});

  return {
    kind: "database",

    /** Resolves once the run row exists; rejects if the database refused it. */
    async open() {
      await ready;
    },

    async record(h, posts, _runAt, window) {
      await ready;
      let newCount = 0;
      const newPosts = [];

      for (const post of posts) {
        // on conflict ... do update always returns a row, even when nothing was
        // inserted, so rowCount can no longer tell new from re-sighted. The
        // xmax = 0 trick can: a freshly inserted row's xmax is 0, an updated
        // row's is not.
        const res = await query(
          `insert into posts (business, platform, hashtag, post_id, first_run_id, first_seen_at,
                              url, preview, author, body, username, caption, image_url,
                              like_count, comment_count, taken_at, enriched_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           on conflict (business, platform, hashtag, post_id) do update set
             like_count    = coalesce(excluded.like_count, posts.like_count),
             comment_count = coalesce(excluded.comment_count, posts.comment_count),
             caption       = coalesce(posts.caption, excluded.caption),
             username      = coalesce(posts.username, excluded.username),
             image_url     = coalesce(posts.image_url, excluded.image_url),
             taken_at      = coalesce(posts.taken_at, excluded.taken_at),
             enriched_at   = coalesce(excluded.enriched_at, posts.enriched_at)
           returning (xmax = 0) as inserted`,
          [
            business,
            h.platform,
            h.value,
            post.id,
            runId,
            runId,
            post.url ?? null,
            post.preview ?? null,
            post.author ?? null,
            post.text ?? null,
            post.username ?? null,
            post.caption ?? null,
            post.imageUrl ?? null,
            post.likeCount ?? null,
            post.commentCount ?? null,
            toIso(post.takenAt),
            post.enrichedAt ?? null,
          ],
        );
        if (res.rows[0]?.inserted) {
          newCount += 1;
          newPosts.push(post);
        }
      }

      const counted = await query(
        `select count(*)::int as n from posts
         where business = $1 and platform = $2 and hashtag = $3`,
        [business, h.platform, h.value],
      );
      return {
        newCount,
        freshCount: countFresh(newPosts, window),
        cumulative: counted.rows[0]?.n ?? 0,
      };
    },

    // A single enriched post, upserted with the same coalesce logic as
    // `record` (fills nulls, refreshes engagement counts). Unlike `record`,
    // this never touches tallies and returns nothing — it exists purely to
    // land enrichment's extra fields on the row `record` already created.
    async enrich(h, record) {
      await ready;
      await query(
        `insert into posts (business, platform, hashtag, post_id, first_run_id, first_seen_at,
                            url, preview, author, body, username, caption, image_url,
                            like_count, comment_count, taken_at, enriched_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         on conflict (business, platform, hashtag, post_id) do update set
           like_count    = coalesce(excluded.like_count, posts.like_count),
           comment_count = coalesce(excluded.comment_count, posts.comment_count),
           caption       = coalesce(posts.caption, excluded.caption),
           username      = coalesce(posts.username, excluded.username),
           image_url     = coalesce(posts.image_url, excluded.image_url),
           taken_at      = coalesce(posts.taken_at, excluded.taken_at),
           enriched_at   = coalesce(excluded.enriched_at, posts.enriched_at)`,
        [
          business,
          h.platform,
          h.value,
          record.id,
          runId,
          runId,
          record.url ?? null,
          record.preview ?? null,
          record.author ?? null,
          record.text ?? null,
          record.username ?? null,
          record.caption ?? null,
          record.imageUrl ?? null,
          record.likeCount ?? null,
          record.commentCount ?? null,
          toIso(record.takenAt),
          record.enrichedAt ?? null,
        ],
      );
    },

    async writeRow(h, _runAt, row) {
      await ready;
      // Always this store's run id: the row the posts and the foreign key
      // point at.
      await query(
        `insert into tallies (business, run_id, platform, hashtag, campaign_day, visit_seq,
                              posts_on_page, new_posts, cumulative_unique, status, message,
                              fresh_posts)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (business, run_id, platform, hashtag) do update set
           posts_on_page = excluded.posts_on_page,
           new_posts = excluded.new_posts,
           cumulative_unique = excluded.cumulative_unique,
           status = excluded.status,
           visit_seq = excluded.visit_seq,
           message = excluded.message,
           fresh_posts = excluded.fresh_posts`,
        [
          business,
          runId,
          h.platform,
          h.value,
          day,
          row.visitSeq ?? null,
          row.postsOnPage,
          row.newCount,
          row.cumulative,
          row.status,
          row.message ?? null,
          row.freshCount ?? 0,
        ],
      );
    },

    async seenCount(h) {
      await ready;
      const counted = await query(
        `select count(*)::int as n from posts
         where business = $1 and platform = $2 and hashtag = $3`,
        [business, h.platform, h.value],
      );
      return counted.rows[0]?.n ?? 0;
    },

    // run_id is an ISO timestamp, so its lexical max IS the newest visit.
    async lastVisits() {
      await ready;
      const res = await query(
        `select platform, hashtag, max(run_id) as last from tallies
         where business = $1 group by platform, hashtag`,
        [business],
      );
      return Object.fromEntries(res.rows.map((r) => [`${r.platform}:${r.hashtag}`, r.last]));
    },

    async finish() {
      await ready;
    },
  };
}

/** Closes out the run row once the loop has ended. */
export async function closeRun(runId, status, abortReason) {
  await query(
    `update runs set status = $2, abort_reason = $3, finished_at = now() where id = $1`,
    [runId, status, abortReason],
  );
}

/**
 * Replaces the run row's targets with what the run actually selected. The row
 * is created before the loop picks its rotation, so over the hashtag cap the
 * initial list would otherwise overstate what this run intended to visit.
 */
export async function setRunTargets(runId, targets) {
  await query(`update runs set targets = $2::jsonb where id = $1`, [
    runId,
    JSON.stringify(targets),
  ]);
}

/** Keeps the run row's heartbeat fresh through the long silent gaps. */
export async function heartbeat(runId) {
  await query(`update runs set heartbeat_at = now() where id = $1`, [runId]);
}

/** Did this business already run on this campaign day, per the database? */
export async function ranOnDay(business, day) {
  const res = await query(
    `select 1 from runs where business = $1 and campaign_day = $2 limit 1`,
    [business, day],
  );
  return res.rowCount > 0;
}

/**
 * Mirrors business definitions into Postgres.
 *
 * The files remain the source of truth — the service reads and writes them — but
 * the UI reads businesses from the database so it never needs filesystem access.
 * The flow is strictly one-directional, files to database, so there is nothing
 * to reconcile.
 */
export async function syncBusinesses(businesses) {
  for (const b of businesses) {
    await query(
      `insert into businesses (slug, name, created_at, hashtags, campaign_start, campaign_end)
       values ($1,$2,$3,$4::jsonb,$5,$6)
       on conflict (slug) do update set
         name = excluded.name,
         hashtags = excluded.hashtags,
         campaign_start = excluded.campaign_start,
         campaign_end = excluded.campaign_end`,
      [
        b.slug,
        b.name,
        b.createdAt ?? new Date().toISOString(),
        JSON.stringify(
          b.hashtags.map((h) => ({ platform: h.platform, hashtag: h.value ?? h.hashtag })),
        ),
        b.campaignStart ?? null,
        b.campaignEnd ?? null,
      ],
    );
  }
  return businesses.length;
}
