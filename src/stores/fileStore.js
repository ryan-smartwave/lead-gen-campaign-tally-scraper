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
 *   finish()                       -> void       (flush; optional)
 *   lastVisits()                   -> { "platform:value": lastRunAt } (optional;
 *                                     feeds least-recently-scraped rotation when
 *                                     a business exceeds maxHashtagsPerRun)
 */

/** Files under `dataDir`: tally.csv, seen.json, posts/*.jsonl. Used by the CLI. */
export function createFileStore(dataDir) {
  // Constructing TallyStore writes (mkdir + csv header), so only do it here,
  // where writing is the intent.
  const store = new TallyStore(dataDir);

  return {
    kind: "file",
    async record(h, posts, runAt) {
      return store.record(h, posts, runAt);
    },
    async writeRow(h, runAt, row) {
      // tally.csv has a fixed 7-column shape; postsOnPage has no column there
      // and is deliberately not appended, to keep the format stable.
      store.writeRow(h, runAt, row.newCount, row.cumulative, row.status);
      store.save();
    },
    async seenCount(h) {
      return (store.seen[TallyStore.key(h)] ?? []).length;
    },
    async lastVisits() {
      return store.lastVisits();
    },
    async finish() {
      store.save();
    },
  };
}
