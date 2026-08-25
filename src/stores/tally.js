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

  writeRow(h, runAt, newCount, cumulative, status, freshCount = 0) {
    const date = runAt.slice(0, 10);
    const row = `${runAt},${date},${h.platform},${h.value},${newCount},${cumulative},${freshCount},${status}\n`;
    fs.appendFileSync(this.csvPath, row);
  }

  save() {
    fs.writeFileSync(this.seenPath, JSON.stringify(this.seen, null, 2));
  }
}
