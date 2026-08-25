# Rich post data, campaign freshness, safe throughput, ban forensics — design

Date: 2026-08-25
Status: approved by Ryan (chat), pending spec review

## Goal

Extend the campaign tally scraper with four capabilities, without weakening the
ANTIBAN.md posture the tool is built on:

1. Capture **like count, image URL, caption, and username** per Instagram post
   (today: only post URL + thumbnail alt text).
2. Tally only posts **posted during the campaign window** ("fresh"), not merely
   posts never seen before.
3. Increase throughput via **longer scrolling and pipelined background tabs** —
   explicitly NOT simultaneous multi-tab scraping, which was evaluated and
   rejected (server-side per-account request patterns make same-account
   parallelism detectable regardless of client behavior).
4. A **forensic journal + incident snapshots** so any future flag/ban can be
   traced to the exact activity that preceded it.

Deduplication of posts is already correct (conflict-keyed insert in the DB
store, `seen.json` in file mode) and is not changed; new fields ride on the
existing insert.

## Decisions made (with Ryan, 2026-08-25)

- **Data depth: hybrid.** Network capture as primary source; capped per-post
  page visits only for records still missing fields.
- **Throughput: longer + pipelined tabs.** No same-account parallel scrolling.
  Multi-account parallelism was offered and not chosen.
- **Freshness: posted-during-campaign.** Store every unique post; tally only
  those inside the campaign window. Unknown-age posts still count.
- **Forensics: full journal + snapshot.** Always-on action journal, plus
  screenshot/HTML/action-tail bundle on any danger sign.

## 1. Rich post fields — hybrid capture (Instagram)

### Capture layer (primary, zero extra requests)

New in-page scripts in `extract.service.js`, driven from the run loop:

- `IG_CAPTURE_INSTALL` — executed after navigation, **before scrolling**.
  Patches `window.fetch` and `XMLHttpRequest` so responses whose URL matches
  Instagram's tag/GraphQL endpoints (`/api/v1/tags/`, `/graphql/query`,
  `/api/v1/feed/`) are cloned into a bounded in-page buffer
  (`window.__swCapture`, capped ~2 MB / ~50 responses, oldest dropped).
  Idempotent: installing twice is a no-op.
- `IG_CAPTURE_HARVEST` — executed after scrolling. Parses the buffer plus the
  inline `<script type="application/json">` blobs that hold the initial grid
  data, and returns normalized records:
  `{id, url, imageUrl, caption, username, likeCount, commentCount, takenAt}`.
  `id` uses the same `ig:<p|reel>/<shortcode>` shape as the DOM extractor so
  records merge cleanly.

The existing DOM grid extraction (`IG_EXTRACT`) remains the **source of truth
for which posts exist**; harvest records only enrich them. If the patch breaks
(field renames, CSP changes), the run degrades to today's behavior; the journal
records `capture_harvest` with `records: 0` so the regression is visible.

### Enrichment fallback (capped post visits)

- Posts **discovered this run** that still miss `takenAt` or
  `caption`/`username` after harvest go into the enrichment queue, in discovery
  order. Backfilling posts from earlier runs is out of scope (capture covers
  fields going forward; a backfill pass can be added later if wanted).
- After the hashtag loop, the run visits at most `safety.maxPostVisitsPerRun`
  (default **8**) post permalinks — same `navigate` → `pageLoadDelay` →
  `assertSafe` → jittered dwell pipeline as hashtag pages, with a jittered gap
  between visits, all inside the existing `maxRunMinutes` budget.
- `IG_POST_EXTRACT` reads fields from the post page: inline JSON first,
  `og:image` / meta tags / DOM as fallback. Sets `enriched_at`.
- A `BlockError` during enrichment aborts the whole run through the existing
  danger path — enrichment gets no special retry.

### Like counts drift

On re-sighting a post, `like_count` (and `comment_count`) are updated when the
captured value differs; `taken_at`, `caption`, `username`, `image_url` are
written only when currently null. Dedup counters are unaffected (an update is
not a new post).

### Facebook

Unchanged. The search feed exposes no reliable like counts or timestamps, and
capture is IG-specific. FB records keep fingerprint id + author + text, and
count as unknown-age (see §2).

### Schema — migration `004_rich_posts.sql`

```sql
alter table posts
  add column if not exists username      text,
  add column if not exists caption       text,
  add column if not exists image_url     text,
  add column if not exists like_count    integer,
  add column if not exists comment_count integer,
  add column if not exists taken_at      timestamptz,
  add column if not exists enriched_at   timestamptz;

alter table tallies
  add column if not exists fresh_posts integer not null default 0;
```

File mode: the same fields appear on JSONL records under `data/<slug>/posts/`;
`seen.json` gains nothing (id-only, as today).

## 2. Fresh posts — campaign window

- `businesses/<slug>.json` gains optional `campaignStart` and `campaignEnd`
  (ISO dates, validated in `config/index.js`; `start <= end` when both set).
  Editable through the existing `PATCH /businesses/:slug`; mirrored to the DB
  by the existing `syncBusinesses` flow.
- A post is **in-campaign** when `taken_at` is inside the window.
  **Unknown-age rule:** only posts *known* to predate the campaign are
  excluded — a null `taken_at` (all FB, unenriched IG) counts. Numbers never
  silently shrink versus today.
- Tallies record `fresh_posts` (new AND in-campaign) alongside `new_posts`.
  With no `campaignStart` configured, `fresh_posts == new_posts`.
- Computation lives in a pure helper (`utils/freshness.js`) used by both
  stores, so the rule cannot drift between modes.

## 3. Throughput — longer scrolls + pipelined tabs

Sequential activity is preserved absolutely: **at no moment do two tabs
scroll or navigate simultaneously.**

- `config.json` (file-only, per the safety firewall): raise
  `scrollsPerHashtag` to ~12 (diminishing returns past ~15–20) and
  `maxRunMinutes` accordingly. New keys: `maxPostVisitsPerRun` (number,
  default 8), `pipelineTabs` (boolean, default true).
- **Pipeline mechanics:** during the jittered gap after hashtag A finishes,
  open hashtag B's URL in a background tab (one navigation request, then
  silence). When the gap elapses: switch to B's tab, run `assertSafe`, dwell,
  scroll. Close A's tab after switching (keep ≤2 scraper tabs open).
  Enrichment visits (§1) do not pipeline — they are few and short.
- Tab operations feature-detect mcp-chrome's tab tools (`listTools` at
  connect). If absent or any tab call fails, the run falls back to today's
  sequential navigate-in-place for the rest of the run and journals the
  downgrade. Pipelining is a refinement, never something that can break a run.
- Because a switch to an already-loaded tab fires no requests, the
  between-hashtag gap may be trimmed in config (suggested `[120s, 300s]` from
  `[180s, 420s]`). This is an operator choice in `config.json`, not a code
  default change.
- ANTIBAN.md gains a section explaining why pipelined-sequential is safe and
  same-account parallel scrolling is not.

## 4. Ban forensics — journal + incident bundles

### Always-on action journal

New `src/services/journal.service.js`:

- `createJournal({root, runId, business})` → appends JSONL to
  `data/journal/<runId>.jsonl` (runId sanitized for Windows filenames).
- One line per action:
  `{at, seq, action, platform, hashtag, detail}` where `action` ∈
  `run_start | wait | navigate | tab_open | tab_switch | dwell | scroll |
  capture_harvest | extract | post_visit | gap | danger | downgrade |
  run_end`. `detail` carries volumes (posts found, records harvested, ms
  waited, visit seq).
- Written in **both** storage modes — operational data, not scraped content,
  same rationale as `runs.log`.
- Journal writes must never break a run: every append is try/caught; a failing
  journal degrades to silence.
- Retention: on run start, delete journal files older than
  `safety.journalRetentionDays` (default **30**).

The run loop calls the journal at each existing step; `humanScroll`,
`navigate`, and the gap waits gain an optional journal parameter rather than
importing it globally (keeps `safety.service.js` dependency-free for tests).

### Incident bundles

On any `BlockError` (hashtag load, after-scroll, or enrichment visit):

- Write `data/incidents/<runId>/incident.json`:
  `{at, runId, business, reason, url, context, tail}` where `tail` is the last
  50 journal entries.
- Best-effort extras, each independently try/caught and feature-detected:
  `screenshot.png` (mcp-chrome screenshot tool) and `page.txt` (first ~50 KB of
  `document.body.innerText` via `evalJs`).
- Append one line to `data/incidents/index.log` (date, runId, business,
  reason) — the cumulative history of every danger sign across months.
- The existing `danger` SSE event gains `incidentDir` so the UI can point at
  the bundle. No DB table — bundles are files so they exist in both modes and
  survive `db:clear`.

## Run-loop order (revised)

```
lock → select targets → start jitter → connect (feature-detect tabs/screenshot)
→ for each hashtag:
    [tab ready from pipeline? switch : navigate] → pageLoadDelay → assertSafe
    → install capture → dwell → humanScroll → assertSafe
    → DOM extract + capture harvest → merge → store.record (enrich queue fills)
    → writeRow (with fresh_posts)
    → gap (open next hashtag's tab in background mid-gap)
→ enrichment: up to maxPostVisitsPerRun post pages, human-paced
→ disconnect → finish → release lock
```

Budget (`maxRunMinutes`) covers everything including enrichment; hitting it
during enrichment ends the run as `budget_stopped` with whatever was enriched.

## Error handling summary

| Failure | Behavior |
|---|---|
| Capture patch/harvest breaks | Degrade to DOM-only; journal `capture_harvest records:0` |
| Tab tools missing/failing | Downgrade to sequential navigation for the rest of the run; journal `downgrade` |
| Danger sign anywhere | Existing abort-never-retry path + incident bundle |
| Journal/incident write fails | Swallowed; never aborts a scrape |
| Enrichment overruns budget | `budget_stopped`, partial enrichment kept |

## Testing (unit only — no Chrome, no DB, no network, matching existing suite)

- Harvest parsing against fixture GraphQL/tag JSON (incl. malformed → `[]`).
- Merge of DOM records with harvest records; like-count update vs null-only
  field fill.
- Enrichment queue: selection (this run's records missing fields only), cap,
  discovery order.
- Freshness helper: window math, unknown-age counts, known-old excluded,
  no-window ⇒ fresh == new.
- Journal: line shape, seq ordering, retention pruning, failing fs swallowed.
- Incident: tail extraction (last 50), bundle content with fake client.
- Pipeline scheduler: never two active tabs scrolling; downgrade path.
- Config validation: new safety keys, campaignStart/End validation.

## Out of scope

- Facebook enrichment (no stable data source).
- Multi-account parallel workers (offered, not chosen; revisit only if
  throughput proves insufficient).
- Any engagement action, ever (ANTIBAN.md §1 stands).
- UI changes beyond consuming new fields/events (separate repo).
