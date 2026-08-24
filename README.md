# Campaign hashtag tally — scraper

> **Paired repository:** `lead-gen-campaign-tally-ui` is a web app that drives this
> scraper as a library and stores results in Postgres instead of files. This repo
> works entirely on its own from the terminal — the UI is optional.

A **standalone** tool that counts posts for a set of **campaign hashtags** on **Facebook and Instagram**, once a day, over the life of a campaign — driven through your own logged-in Chrome via [mcp-chrome](https://github.com/hangwin/mcp-chrome).

It is designed around one hard requirement: **run daily for months without getting the account flagged or banned.** Read [ANTIBAN.md](ANTIBAN.md) — it is the design basis, not an afterthought.

> Standalone: this lives in the SmartWave repo for convenience but has no dependency on the lead-gen product. It's a self-contained monitoring tool.

## What it produces

- **`data/tally.csv`** — the deliverable: one row per hashtag per run — `run_at, date, platform, hashtag, new_posts, cumulative_unique, status`. This is your campaign time series (daily new posts + running unique total per hashtag).
- **`data/posts/<platform>-<hashtag>.jsonl`** — audit trail of every post counted (id, url, preview/author, firstSeenAt).
- **`data/seen.json`** — cumulative unique post IDs per hashtag (dedup memory; makes the tally crash- and skip-resilient).

## How it works (one daily run)

```
shuffle hashtags ─► for each (bounded by maxHashtagsPerRun & maxRunMinutes):
   navigate to hashtag page  ─► assertSafe (login/checkpoint/rate-limit? → ABORT run, no retry)
   random dwell ─► human incremental scroll ×N with jittered pauses ─► assertSafe again
   extract unique post IDs in-page (chrome_javascript, read-only)
   record new vs. cumulative ─► append tally row
   random multi-minute gap ─► next hashtag
```

Everything is **read-only** (navigate, scroll, read DOM). No likes, follows, comments, or DMs — ever.

## Businesses

Each business tracked has its own hashtags, history and duplicate-tracking:

```
config.json              shared: mcpEndpoint + safety limits (the anti-ban firewall)
businesses/<id>.json     per business: { name, hashtags: [{platform, value}] }
data/<id>/               per business: tally.csv, seen.json, posts/, run.lock
```

```bash
npm run businesses            # list what's defined
npm run run-once              # scrape the first business
node src/index.js --run --business acme-events
node src/index.js --check --business acme-events
```

Businesses are easiest to manage from the settings screen of the paired
`lead-gen-campaign-tally-ui` repo, which writes these same files. Editing them by
hand works identically.

Separate `seen.json` files mean two businesses tracking the same hashtag keep independent counts
and cannot corrupt each other. They share one Chrome session, so only one may scrape at a time —
the per-business `run.lock` plus the single session enforce that.

## Setup (one-time)

1. Install the **mcp-chrome extension** (from its [releases](https://github.com/hangwin/mcp-chrome/releases), load unpacked at `chrome://extensions/`) and the bridge: `npm install -g mcp-chrome-bridge`.
2. Open the extension popup → **Connect** (shows *Service Running · Port 12306*).
3. In that same Chrome profile, **log into Instagram and Facebook** — use a **dedicated, aged account you can afford to lose**, not a personal/primary one (see ANTIBAN.md §2).
4. `npm install`.

## Usage

```bash
npm run check      # verify the mcp-chrome connection
npm run run-once   # perform ONE daily run over all configured hashtags
```

Run it **manually once a day**, or schedule it once daily at a slightly randomized time (e.g. Windows Task Scheduler). **Do not** loop it or run it more than once a day — that defeats the entire anti-ban design.

## Configuration (`config.json`)

```json
"hashtags": [ { "platform": "instagram", "value": "yourcampaigntag" } ],
"safety": {
  "maxHashtagsPerRun": 12,           // hard cap on pages touched per run
  "maxRunMinutes": 60,               // run stops when the clock budget is hit
  "scrollsPerHashtag": 5,            // gentle sampling; more = more posts but more risk
  "scrollPauseMs": [3000, 9000],     // randomized pause between scrolls
  "gapBetweenHashtagsMs": [180000, 420000],  // 3–7 min randomized gap between searches
  "initialDwellMs": [2000, 5000],    // human "look at the page" pause on load
  "pageLoadDelayMs": 6000
}
```

All delays are **ranges** — the tool picks a random value inside each, so there is no fixed rhythm to fingerprint. The gap range is what stretches a run across the 30–60 min window dyoool asked for.

## Platform notes (validated 2026-08-24)

- **Instagram** is the strong target: an IG hashtag page yields ~50–70 posts per run, identified by post shortcode (`/p/…`, `/reel/…`) with the caption captured (supplier @mentions and all).
- **Facebook** works but returns fewer (~4–15/run). FB is scraped via `facebook.com/search/posts?q=%23<tag>`, not `/hashtag/` (Meta degraded the latter). Facebook **redacts post URLs** in the automation layer, so posts are identified by a **content fingerprint** (author + caption, digits stripped so changing engagement counts don't drift the id) rather than by URL; real photo/album `fbid`s are used when present. This means FB records have no `url`, only a stable `id` — fine for a tally.
- mcp-chrome also redacts person names in returned fields (author may show `<redacted>`), but the real name is inside the caption text and is used for the in-page fingerprint, so counting/dedup is unaffected.
- The tally counts **unique posts observed via sampling**, not the platform's true total hashtag count (never reliably exposed). Over a daily campaign the cumulative curve is the useful signal.
- DOM selectors and extraction logic live in [src/extract.js](src/extract.js) and are brittle by nature — FB/IG change markup without notice. [diagnose.mjs](diagnose.mjs) is a dev helper for re-inspecting a page's structure when extraction returns 0: `node diagnose.mjs "<url>"`.
- If a run aborts on a danger signal, **stop for the day**, clear the checkpoint manually in the browser, and resume tomorrow. Blocks escalate on retry.
