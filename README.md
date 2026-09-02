# Campaign hashtag tally — scraper service

Counts posts for a set of **campaign hashtags** on **Instagram and Facebook**, for
any number of campaigns, by driving your own signed-in Chrome through
[mcp-chrome](https://github.com/hangwin/mcp-chrome). Results go to Postgres.

Runs as a **local Express service** that the
[`lead-gen-campaign-tally-ui`](../lead-gen-campaign-tally-ui) app calls over HTTP,
and also works as a **standalone CLI** with no database at all.

It is designed around one hard requirement: **run daily for months without the
account getting flagged.** Read [ANTIBAN.md](ANTIBAN.md) — it is the design basis,
not an afterthought.

## Why a service

A run takes 30–60 minutes. Owning it in its own process means a run survives the
UI being restarted, rebuilt or closed — and because only this process holds the
Chrome session, shutdown can release it cleanly instead of leaving a ghost that
blocks the next run.

It listens on **loopback only**, deliberately: these endpoints drive a real
signed-in browser, so they must not be reachable from the network.

## Setup

1. Install the **mcp-chrome extension** (from its
   [releases](https://github.com/hangwin/mcp-chrome/releases), loaded unpacked at
   `chrome://extensions/`) and the bridge: `npm install -g mcp-chrome-bridge`.
2. Open the extension popup → **Connect** (shows *Service Running · Port 12306*).
3. In that Chrome profile, **log into Instagram and Facebook** — use a
   **dedicated, aged account you can afford to lose**, not a personal one (see
   ANTIBAN.md §2).
4. `npm install`, then `cp .env.example .env` and put your Postgres connection
   string in it.
5. **Apply migrations:** `npm run db:migrate`. The schema currently runs through
   migration 008: rich post fields, campaign freshness, other-hashtags,
   the business → campaign rename, and duration/provenance/location columns.
6. `npm run serve`

## Commands

```bash
npm run serve        # the HTTP service (what the UI talks to)
npm run campaigns   # list configured campaigns
npm run check        # verify the mcp-chrome connection
npm run run-once     # scrape from the terminal, writing FILES (no database)
npm run db:migrate   # apply schema migrations
npm run db:check     # read back what the database holds
npm run db:clear     # empty collected results, keeping campaigns
npm test             # unit tests (no Chrome, no database, no network)
```

## Campaigns

Each campaign has its own hashtags and its own history:

```
config.json              shared: mcpEndpoint + safety limits (the anti-ban firewall)
campaigns/<id>.json     per campaign: { name, hashtags: [{platform, value}],
                         campaignStart?, campaignEnd?, country?, fbLocationId? }
data/
  run.lock               guards Chrome — global, because every campaign shares one session
  runs.log               one line per run (memory behind the once-a-day guard)
  <id>/                  CLI-mode results (CSV + JSONL + seen.json dedup)
  journal/<runId>.jsonl  forensic action log — always-on, one line per navigation/scroll/
                         dwell/gap/capture/post-visit/danger event, pruned after 30 days
  incidents/<runId>/     written on any danger sign: incident.json (reason, url, context,
                         last 50 actions), best-effort page.txt and screenshot.png
  incidents/index.log    cumulative index of all incidents
```

Manage them from the UI's settings screen, or edit the files directly — the
service reads and writes the same files, so the two can never disagree. It
mirrors campaign definitions into Postgres on change and at startup, so the UI
can read them without filesystem access.

**Safety limits are file-only and have no write route.** Hashtags are content;
timing and volume limits are what keep the account unflagged, so nothing in the
API can widen them.

**Campaign freshness:** Each campaign may optionally set `campaignStart` and/or
`campaignEnd` as ISO YYYY-MM-DD dates (e.g., `"2026-01-15"`) in its
`campaigns/<slug>.json` file, editable via the PATCH `/campaigns/:slug` route.
Tallies then record both `new_posts` (posts not seen in prior runs) and
`fresh_posts` (posts that are both new AND posted within the campaign window).
Posts of unknown age (all Facebook records, unenriched Instagram) still count —
only posts known to predate the campaign are excluded.

When **both** dates are set, Facebook searches are also date-filtered at the
source: the visit URL carries Facebook's own `rp_creation_time` filter (day
granularity), so most out-of-window posts never appear at all. A campaign with
only one date (or neither) gets unfiltered Facebook searches. Instagram has no
date facility; its filtering happens after capture, via enrichment.

**Location targeting:** each campaign has a `country` (default `"Philippines"`,
recorded with results) and an optional `fbLocationId`, which adds Facebook's
`rp_location` filter to search URLs. Use a **city or metro place id** —
country-level ids are silently ignored by Facebook (verified live). Instagram
search has no location facility.

**More hashtags than `maxHashtagsPerRun`?** A run visits at most that many (10
in the shipped config). A campaign tracking more still gets full coverage — each run picks
the **least recently scraped** hashtags first — but on a rotation, so a hashtag
that sat a day out has a gap in its daily series (the cumulative curve is
unaffected). Preflight reports a `coverage` warning whenever this rotation is
active.

**Runs start immediately.** The first hashtag is visited as soon as the run
connects; the only enforced waits are the randomized gaps between hashtags
(`gapBetweenHashtagsMs`).

**Platforms alternate.** After the least-recently-scraped ordering, hashtags are
interleaved Instagram/Facebook so each platform rests for the whole of the
other's scroll. A switch to the other platform uses the shorter
`crossPlatformGapMs` instead of the full hashtag gap.

**Every visit explains itself.** `hashtag_done` events (and the `tallies` rows
behind them) carry `durationSeconds`, `scrollSteps` and a `stopReason` — `dry`
(the feed stopped surfacing posts new to the campaign), `post_cap`
(`maxPostsPerHashtag` reached), `budget` (time budget spent) or `steps` (fixed
step count done). Each post also records **per-field provenance** in
`field_sources`: which passive source supplied each value (capture, React prop,
DOM, derived, enrichment), or `missed:<sources tried>` when everything came up
empty.

**Safety configuration keys** (in `config.json`, file-only). The shipped config
runs **deep-scroll mode**: 10 hashtags per run, 20–28 minutes each, inside a
330-minute budget.
- `maxHashtagsPerRun` (required; shipped 10): cap on hashtags visited per run
- `maxRunMinutes` (required; shipped 330): total run duration limit
- `scrollsPerHashtag` (required; shipped 5): incremental scroll steps per hashtag
  page — only used when `scrollMinutesPerHashtag` is not set
- `scrollMinutesPerHashtag` (`[min, max]` minutes, optional, capped at 45): deep-scroll
  mode — scroll each hashtag for a randomized time budget instead of a step count.
  See "Deep scroll mode" in [ANTIBAN.md](ANTIBAN.md). When set, pair it with a lower
  `maxHashtagsPerRun` and a higher `maxRunMinutes`
- `scrollPauseMs` (`[min, max]`, default 3000–9000): jitter between scroll steps
- `restEveryMs` / `restPauseMs` (`[min, max]`, defaults 2.5–5 min / 15–45 s):
  randomized "reading breaks" inside long scrolls
- `dryStopAfterScrolls` (default 10, shipped 7, 0 disables): end a hashtag after this many
  consecutive scroll steps that surface no posts new to the campaign — the scroll
  stops at the frontier of what previous runs already recorded, so daily runs
  shrink automatically once the backlog is captured
- `maxPostsPerHashtag` (default 3000, 0 disables): end a hashtag once this many
  posts have been collected
- `gapBetweenHashtagsMs` (`[min, max]`, default 3–7 minutes): idle gap between hashtags
- `crossPlatformGapMs` (`[min, max]`, default 1–2.5 minutes): shorter gap used when
  the next hashtag is on the other platform — the platform being left just
  started a rest that lasts the other's whole scroll
- `initialDwellMs` (`[min, max]`, default 2–5 seconds): dwell before first scroll
- `pageLoadDelayMs` (default 6000): wait after navigation before scraping
- `maxPostVisitsPerRun` (default 8): cap on individual post enrichment visits per run
- `postVisitGapMs` (`[min, max]`, default 45–120 seconds): pause between
  enrichment post visits — its own pacing, since the full hashtag gap between
  two post clicks resembles no human behavior
- `pipelineTabs` (default true): enable single-tab pre-navigation during hashtag gaps
- `journalRetentionDays` (default 30): days to keep forensic action logs

## HTTP API

All JSON, all loopback.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness, database and Chrome config, whether a run is live |
| `GET` | `/preflight?campaign=` | can a run start, and if not exactly why |
| `GET` | `/campaigns` | list campaigns and their hashtags |
| `POST` | `/campaigns` | create one (`{name, hashtags}`) |
| `PATCH` | `/campaigns/:slug` | update name, hashtags, campaign window, country and/or fbLocationId |
| `DELETE` | `/campaigns/:slug` | remove the definition; results are kept |
| `POST` | `/runs` | start a run (`{campaign, force?}`) → `202` |
| `GET` | `/runs/active` | replayable snapshot of the in-flight run |
| `DELETE` | `/runs/active` | stop a live run, or dismiss a finished one's log |
| `GET` | `/runs/events?sinceSeq=` | server-sent event stream |

Refusals are meaningful, not generic: `already_ran_today` (overridable with
`force`), `already_running`, `mcp_unreachable`, `db_not_configured`,
`no_hashtags`.

## Layout

```
bin/cli.js              standalone CLI (file-backed, no database)
src/index.js            service entry point
src/app.js              Express app
src/config/             config.json + campaigns, and env
src/controllers/         request handling
src/routes/              endpoint definitions
src/middlewares/         error translation
src/services/            the run loop, MCP client, extraction, safety, supervisor
src/stores/              file-backed and Postgres-backed run stores
src/db/                  connection pool
src/utils/               campaign day, run ledger, ApiError
db/migrations/           schema (this repo owns it, being the writer)
```

## Two storage modes

| Mode | Used by | Results go to | Deduplication |
|---|---|---|---|
| **database** | `npm run serve` | Postgres | count of post rows actually inserted |
| **file** | `npm run run-once` | `data/<id>/` CSV + JSONL | `seen.json` |

Both are the same run loop with a different store injected. **Don't mix them for
the same campaign** — each keeps its own deduplication memory, so a hashtag
scraped through one path looks new to the other.

Two things stay on disk in either mode, and neither is scraped content:
`data/run.lock` (guards Chrome — global, because every campaign shares one
browser session) and `data/runs.log` (one line per run, the memory behind the
once-a-day guard, so clearing the database cannot make it forget).

## Platform notes

- **Instagram** is the strong target: a hashtag page yields ~50–150 posts per
  run, identified by post shortcode. Note Instagram now redirects
  `/explore/tags/<tag>/` to its keyword-search page; extraction handles both.
  The DOM is read incrementally after every scroll step (the grid is
  virtualized — posts scrolled past leave the DOM, so a single read at the end
  would lose most of them). Every post gets an **image URL** via Instagram's
  stable `/p/<shortcode>/media/?size=l` redirect (signed CDN URLs expire within
  weeks; this one doesn't). **Username, caption, like count, posted-at** come
  from two passive sources: `chrome_network_capture` response bodies (started
  before navigation, zero extra requests) and an in-page walk of the inline
  Relay JSON that returns compact records — raw payloads cannot be shipped out
  of the page because mcp-chrome truncates large tool results and redacts URLs
  carrying query strings. Grid pages expose little of this, so the main source
  is the capped enrichment phase: it visits individual post pages (their inline
  JSON carries everything) for records still missing fields
  (`safety.maxPostVisitsPerRun`, default 8 per run), at human pace with the
  same jitter and danger checks as the main loop, and aborts on any BlockError
  without retry.
- **Facebook** works but returns fewer (~4–15/run), and is scraped via
  `facebook.com/search/posts?q=%23<tag>` rather than `/hashtag/` — with the
  campaign's date window and `fbLocationId` applied as native search filters
  when configured. Facebook hides post URLs from the automation layer, so posts
  are identified by a photo/album `fbid` when one is exposed, else by a
  **content fingerprint** of author and caption. Records are richer than they
  used to be: permalinks are derived from harvested `fbid`s, author names are
  recovered (base64-tagged in-page past the bridge's redaction, with a
  card-text parser as fallback), and captions, images and like/comment counts
  come from network capture when Facebook's responses carry them. What they
  still never have is a **timestamp**, and they are not enrichable — freshness
  counts them as in-window.
- mcp-chrome also redacts person names in returned fields, so an author may read
  `<redacted>`. The real name is inside the caption text used for the
  fingerprint, so counting is unaffected.
- Selectors live in [src/services/extract.service.js](src/services/extract.service.js)
  and are brittle by nature. [diagnose.mjs](diagnose.mjs) runs the real collect
  pipeline once, with abbreviated pacing, when extraction misbehaves:
  `node diagnose.mjs [instagram|facebook] [hashtag]`.
