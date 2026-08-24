import { query, requireDb } from "../db/pool.js";
import { campaignDay } from "../utils/day.js";

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

  return {
    kind: "database",

    async record(h, posts) {
      await ready;
      let newCount = 0;

      for (const post of posts) {
        // A no-op insert returns no rows, so the returned count IS the number of
        // genuinely new posts — dedup and persistence in one step.
        const res = await query(
          `insert into posts (business, platform, hashtag, post_id, first_run_id, first_seen_at,
                              url, preview, author, body)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           on conflict (business, platform, hashtag, post_id) do nothing`,
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
          ],
        );
        if (res.rowCount > 0) newCount += 1;
      }

      const counted = await query(
        `select count(*)::int as n from posts
         where business = $1 and platform = $2 and hashtag = $3`,
        [business, h.platform, h.value],
      );
      return { newCount, cumulative: counted.rows[0]?.n ?? 0 };
    },

    async writeRow(h, _runAt, row) {
      await ready;
      // Always this store's run id: the row the posts and the foreign key
      // point at.
      await query(
        `insert into tallies (business, run_id, platform, hashtag, campaign_day, visit_seq,
                              posts_on_page, new_posts, cumulative_unique, status, message)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (business, run_id, platform, hashtag) do update set
           posts_on_page = excluded.posts_on_page,
           new_posts = excluded.new_posts,
           cumulative_unique = excluded.cumulative_unique,
           status = excluded.status,
           visit_seq = excluded.visit_seq,
           message = excluded.message`,
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
      `insert into businesses (slug, name, created_at, hashtags)
       values ($1,$2,$3,$4::jsonb)
       on conflict (slug) do update set name = excluded.name, hashtags = excluded.hashtags`,
      [
        b.slug,
        b.name,
        b.createdAt ?? new Date().toISOString(),
        JSON.stringify(
          b.hashtags.map((h) => ({ platform: h.platform, hashtag: h.value ?? h.hashtag })),
        ),
      ],
    );
  }
  return businesses.length;
}
