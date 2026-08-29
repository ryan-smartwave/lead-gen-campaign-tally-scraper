import { TallyStore } from "./tally.js";

/**
 * Storage backends for a run.
 *
 * The run loop does not know or care where results go. The CLI supplies a
 * file-backed store (standalone, no database needed); the web app supplies a
 * Postgres-backed one so nothing is written to disk at all.
 *
 * A store owns two things that must agree: where results are recorded, and what
 * counts as "already seen". Deduplication has to come from the same place the
 * results do — a run writing to Postgres while deduplicating against a local
 * file would recount everything the moment the two drifted apart.
 *
 * Contract (every method may be async):
 *   record(hashtag, posts, runAt)  -> { newCount, cumulative }
 *   writeRow(hashtag, runAt, row)  -> void
 *   seenCount(hashtag)             -> number     (for the error/abort path)
 *   seenIds(hashtag)               -> [postId,…] (optional; lets the collector
 *                                     stop scrolling once the feed serves only
 *                                     already-recorded posts)
 *   finish()                       -> void       (flush; optional)
 *   lastVisits()                   -> { "platform:value": lastRunAt } (optional;
 *                                     feeds least-recently-scraped rotation when
 *                                     a business exceeds maxHashtagsPerRun)
 *   enrich(hashtag, record, runAt) -> void        (optional; merges a single
 *                                     enriched post's fields into what was
 *                                     already recorded for it — NOT the same
 *                                     as calling `record` again, which a
 *                                     dedup-by-id store would treat as
 *                                     already-seen and drop)
 */

/** Files under `dataDir`: tally.csv, seen.json, posts/*.jsonl. Used by the CLI. */
export function createFileStore(dataDir) {
  // Constructing TallyStore writes (mkdir + csv header), so only do it here,
  // where writing is the intent.
  const store = new TallyStore(dataDir);

  return {
    kind: "file",
    async record(h, posts, runAt, window) {
      return store.record(h, posts, runAt, window);
    },
    // Merges an enrichment result into the post already recorded for it.
    // Deliberately NOT `record` — TallyStore.record only writes posts not yet
    // in seen.json, and the post is already there from the first sighting, so
    // routing enrichment through `record` silently discards it.
    async enrich(h, record) {
      store.enrichPost(h, record);
    },
    async writeRow(h, runAt, row) {
      // tally.csv has a fixed 8-column shape (added fresh_posts); postsOnPage has no column there
      // and is deliberately not appended, to keep the format stable.
      store.writeRow(h, runAt, row.newCount, row.cumulative, row.status, row.freshCount);
      store.save();
    },
    async seenCount(h) {
      return (store.seen[TallyStore.key(h)] ?? []).length;
    },
    // Every post id already recorded for this hashtag. Feeds the collector's
    // known-frontier stop: scrolling ends once the feed serves only posts the
    // campaign already has, so daily runs spend requests only on what's new.
    async seenIds(h) {
      return store.seen[TallyStore.key(h)] ?? [];
    },
    async lastVisits() {
      return store.lastVisits();
    },
    async finish() {
      store.save();
    },
  };
}
