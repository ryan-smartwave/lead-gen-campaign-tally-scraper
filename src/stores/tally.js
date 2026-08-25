import fs from "node:fs";
import path from "node:path";
import { countFresh } from "../utils/freshness.js";

// Cumulative, crash-resilient tally store:
//   seen.json          — { "<platform>:<value>": [postId, ...] } all-time unique IDs per hashtag
//   posts/<key>.jsonl  — one line per newly-seen post (audit trail of what was counted)
//   tally.csv          — one row per hashtag per run: the campaign time series

export class TallyStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.postsDir = path.join(dataDir, "posts");
    this.seenPath = path.join(dataDir, "seen.json");
    this.csvPath = path.join(dataDir, "tally.csv");
    fs.mkdirSync(this.postsDir, { recursive: true });
    this.seen = fs.existsSync(this.seenPath)
      ? JSON.parse(fs.readFileSync(this.seenPath, "utf8"))
      : {};
    if (!fs.existsSync(this.csvPath)) {
      fs.writeFileSync(
        this.csvPath,
        "run_at,date,platform,hashtag,new_posts,cumulative_unique,fresh_posts,status\n",
      );
    }
  }

  static key(h) {
    return `${h.platform}:${h.value}`;
  }

  // Records freshly-seen posts, returns { newCount, freshCount, cumulative }.
  record(h, posts, runAt, window = { start: null, end: null }) {
    const key = TallyStore.key(h);
    const seenIds = new Set(this.seen[key] ?? []);
    const fresh = posts.filter((p) => !seenIds.has(p.id));
    for (const p of fresh) seenIds.add(p.id);
    this.seen[key] = [...seenIds];

    if (fresh.length) {
      const lines =
        fresh
          .map((p) => JSON.stringify({ ...p, firstSeenAt: runAt }))
          .join("\n") + "\n";
      fs.appendFileSync(path.join(this.postsDir, `${h.platform}-${h.value}.jsonl`), lines);
    }
    const freshCount = countFresh(fresh, window);
    return { newCount: fresh.length, freshCount, cumulative: seenIds.size };
  }

  // When was each hashtag last visited? Read from tally.csv rather than kept in
  // a side file, so history that predates this method still counts. Safe to
  // split on commas: hashtag values are validated to contain none.
  lastVisits() {
    const out = {};
    let text;
    try {
      text = fs.readFileSync(this.csvPath, "utf8");
    } catch {
      return out;
    }
    for (const line of text.split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      const [runAt, , platform, hashtag] = line.split(",");
      if (!runAt || !platform || !hashtag) continue;
      const key = `${platform}:${hashtag}`;
      if (!(key in out) || runAt > out[key]) out[key] = runAt;
    }
    return out;
  }

  // Merges enrichment results into an already-recorded post line in
  // posts/<platform>-<value>.jsonl. Deliberately does NOT touch seen.json or
  // any count: the post was already counted by `record`, enrichment only
  // fills in detail it didn't have yet. A missing file or unmatched id is a
  // silent no-op — enrichment is best-effort and must never throw.
  enrichPost(h, record) {
    const file = path.join(this.postsDir, `${h.platform}-${h.value}.jsonl`);
    let lines;
    try {
      lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    } catch {
      return;
    }
    let changed = false;
    const merged = lines.map((line) => {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        return line;
      }
      if (row.id !== record.id) return line;
      changed = true;
      const next = { ...row };
      // Fill fields the DOM-only sighting left empty.
      for (const k of ["caption", "username", "takenAt", "imageUrl"]) {
        if (next[k] == null && record[k] != null) next[k] = record[k];
      }
      // Engagement counts are refreshed, not just filled — a later visit's
      // like/comment count is more current than the first sighting's.
      for (const k of ["likeCount", "commentCount"]) {
        if (record[k] != null) next[k] = record[k];
      }
      // Always stamped: this store call IS the enrichment event, so it marks
      // when it happened even if the caller's record forgot to.
      next.enrichedAt = record.enrichedAt ?? new Date().toISOString();
      return JSON.stringify(next);
    });
    if (!changed) return;
    fs.writeFileSync(file, merged.join("\n") + "\n");
  }

  writeRow(h, runAt, newCount, cumulative, status, freshCount = 0) {
    const date = runAt.slice(0, 10);
    const row = `${runAt},${date},${h.platform},${h.value},${newCount},${cumulative},${freshCount},${status}\n`;
    fs.appendFileSync(this.csvPath, row);
  }

  save() {
    fs.writeFileSync(this.seenPath, JSON.stringify(this.seen, null, 2));
  }
}
