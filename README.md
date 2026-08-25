# Campaign hashtag tally — scraper service

Counts posts for a set of **campaign hashtags** on **Instagram and Facebook**, for
any number of businesses, by driving your own signed-in Chrome through
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
5. **Apply migrations:** `npm run db:migrate` (includes schema migration 004 for
   rich post fields and campaign freshness tallies).
6. `npm run serve`

## Commands

```bash
npm run serve        # the HTTP service (what the UI talks to)
npm run businesses   # list configured businesses
npm run check        # verify the mcp-chrome connection
npm run run-once     # scrape from the terminal, writing FILES (no database)
npm run db:migrate   # apply schema migrations
npm run db:check     # read back what the database holds
npm run db:clear     # empty collected results, keeping businesses
npm test             # unit tests (no Chrome, no database, no network)
```

## Businesses

Each business has its own hashtags and its own history:

```
config.json              shared: mcpEndpoint + safety limits (the anti-ban firewall)
businesses/<id>.json     per business: { name, hashtags: [{platform, value}],
                         campaignStart?, campaignEnd? }
data/
  run.lock               guards Chrome — global, because every business shares one session
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
mirrors business definitions into Postgres on change and at startup, so the UI
can read them without filesystem access.

**Safety limits are file-only and have no write route.** Hashtags are content;
timing and volume limits are what keep the account unflagged, so nothing in the
API can widen them.

**Campaign freshness:** Each business may optionally set `campaignStart` and/or
`campaignEnd` as ISO YYYY-MM-DD dates (e.g., `"2026-01-15"`) in its
`businesses/<slug>.json` file, editable via the PATCH `/businesses/:slug` route.
Tallies then record both `new_posts` (posts not seen in prior runs) and
`fresh_posts` (posts that are both new AND posted within the campaign window).
Posts of unknown age (all Facebook records, unenriched Instagram) still count —
only posts known to predate the campaign are excluded.

**More hashtags than `maxHashtagsPerRun`?** A run visits at most that many (12
by default). A business tracking more still gets full coverage — each run picks
the **least recently scraped** hashtags first — but on a rotation, so a hashtag
that sat a day out has a gap in its daily series (the cumulative curve is
unaffected). Preflight reports a `coverage` warning whenever this rotation is
active.

**Runs start immediately.** The first hashtag is visited as soon as the run
connects; the only enforced waits are the randomized gaps between hashtags
(`gapBetweenHashtagsMs`).

**Safety configuration keys** (in `config.json`, file-only):
- `maxHashtagsPerRun` (default 12): cap on hashtags visited per run
- `maxRunMinutes` (default 60): total run duration limit
- `scrollsPerHashtag` (default 5): incremental scroll steps per hashtag page
- `scrollPauseMs` (`[min, max]`, default 3000–9000): jitter between scroll steps
- `gapBetweenHashtagsMs` (`[min, max]`, default 3–7 minutes): idle gap between hashtags
- `initialDwellMs` (`[min, max]`, default 2–5 seconds): dwell before first scroll
- `pageLoadDelayMs` (default 6000): wait after navigation before scraping
- `maxPostVisitsPerRun` (default 8): cap on individual post enrichment visits per run
- `pipelineTabs` (default true): enable single-tab pre-navigation during hashtag gaps
- `journalRetentionDays` (default 30): days to keep forensic action logs

## HTTP API

All JSON, all loopback.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness, database and Chrome config, whether a run is live |
| `GET` | `/preflight?business=` | can a run start, and if not exactly why |
| `GET` | `/businesses` | list businesses and their hashtags |
| `POST` | `/businesses` | create one (`{name, hashtags}`) |
| `PATCH` | `/businesses/:slug` | rename and/or replace its hashtags |
| `DELETE` | `/businesses/:slug` | remove the definition; results are kept |
| `POST` | `/runs` | start a run (`{business, force?}`) → `202` |
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
src/config/             config.json + businesses, and env
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
the same business** — each keeps its own deduplication memory, so a hashtag
scraped through one path looks new to the other.

Two things stay on disk in either mode, and neither is scraped content:
`data/run.lock` (guards Chrome — global, because every business shares one
browser session) and `data/runs.log` (one line per run, the memory behind the
once-a-day guard, so clearing the database cannot make it forget).

## Platform notes

- **Instagram** is the strong target: a hashtag page yields ~50–70 posts per run,
  identified by post shortcode. Rich fields — **username, caption, image URL,
  like count, posted-at timestamp** — are captured by patching the page's own
  `fetch`/XHR and reading Instagram's GraphQL/API responses in-page (zero extra
  requests). A capped fallback visits individual post pages for records still
  missing fields (`safety.maxPostVisitsPerRun`, default 8 per run), at human
  pace with the same jitter and danger checks as the main loop, and aborts on
  any BlockError without retry.
- **Facebook** works but returns fewer (~4–15/run), and is scraped via
  `facebook.com/search/posts?q=%23<tag>` rather than `/hashtag/`. Facebook hides
  post URLs from the automation layer, so those posts are identified by a
  **content fingerprint** of author and caption. Facebook records have no URL,
  no like count, and no timestamp — fine for a tally, but not enrichable.
- mcp-chrome also redacts person names in returned fields, so an author may read
  `<redacted>`. The real name is inside the caption text used for the
  fingerprint, so counting is unaffected.
- Selectors live in [src/services/extract.service.js](src/services/extract.service.js)
  and are brittle by nature. [diagnose.mjs](diagnose.mjs) re-inspects a page when
  extraction returns 0: `node diagnose.mjs "<url>"`.
