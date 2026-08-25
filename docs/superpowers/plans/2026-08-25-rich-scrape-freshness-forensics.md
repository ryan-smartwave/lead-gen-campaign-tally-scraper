# Rich Post Data, Campaign Freshness, Safe Throughput & Ban Forensics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the campaign tally scraper to capture like counts / image / caption / username per Instagram post, tally only posts made during the campaign window, raise throughput via longer scrolls + pipelined background tabs (no same-account parallel scraping), and record a forensic journal + incident bundle so any future flag can be traced.

**Architecture:** New enrichment data comes from patching the tab's own `fetch`/`XHR` and reading Instagram's own GraphQL responses (zero extra requests), with a capped per-post-page fallback. A pure `normalizeCaptured` function turns raw captured JSON into records, so all parsing is unit-testable without a browser. Freshness is a pure helper shared by both stores. Throughput uses one-tab-active pipelining that only pre-navigates the next hashtag during the existing between-hashtag gap. Forensics is an always-on JSONL journal plus a best-effort incident bundle written on any `BlockError`.

**Tech Stack:** Node.js ≥20 (ES modules), `node:test` + `node:assert/strict` (no test framework deps), Express 5, `pg`, `@modelcontextprotocol/sdk` driving mcp-chrome. Windows-first (paths, filename sanitization).

**Spec:** [docs/superpowers/specs/2026-08-25-rich-scrape-freshness-forensics-design.md](../specs/2026-08-25-rich-scrape-freshness-forensics-design.md)

## Global Constraints

- **Read-only, always.** No like/follow/comment/DM/navigation-to-engage. Every new page interaction is navigate + scroll + read only. (ANTIBAN.md §1)
- **One tab active at a time.** Pipelining may *pre-navigate* the next hashtag's tab during a gap, but no two tabs may scroll or navigate simultaneously. (Spec §3)
- **Abort-never-retry on danger.** Any `BlockError` ends the whole run through the existing danger path; enrichment and pipelining get no retry. (ANTIBAN.md §7)
- **Safety config is file-only.** New keys (`maxPostVisitsPerRun`, `pipelineTabs`, `journalRetentionDays`) live in `config.json` under `safety`; no API write path may set them. (Spec §3, config/index.js)
- **Never shrink counts silently.** Unknown-age posts (null `taken_at`) still count as fresh. Only posts *known* to predate the campaign are excluded. (Spec §2)
- **Operational logging must never break a scrape.** Every journal/incident write is individually try/caught and degrades to silence. (Spec §4)
- **ES modules, `.js` extensions in imports, `import`/`export`.** Match existing files exactly.
- **Tests:** `node --test test/`, files named `*.test.js`, using `node:test` + `node:assert/strict`. No new runtime or dev dependencies.
- **Feature-detect MCP tools** (tab tools, screenshot) from `client.listTools()` at connect; missing tools ⇒ graceful downgrade, journaled, never a run failure.
- Commit messages end with the Co-Authored-By trailer used in this repo's history.

---

### Task 1: Campaign-freshness helper

**Files:**
- Create: `src/utils/freshness.js`
- Test: `test/freshness.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseWindow({ campaignStart, campaignEnd })` → `{ start: Date|null, end: Date|null }` (invalid/absent → null).
  - `isFresh(takenAt, window)` → `boolean`. `takenAt` may be an ISO string, epoch seconds (number), epoch ms (number), a `Date`, or null/undefined. Rule: null/unparseable ⇒ `true` (unknown age counts). With a parsed date: `true` unless it is strictly before `window.start`, or after `window.end`.
  - `countFresh(posts, window)` → `number` (posts whose `.takenAt` is fresh).

- [ ] **Step 1: Write the failing tests**

```js
// test/freshness.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWindow, isFresh, countFresh } from "../src/utils/freshness.js";

test("no window means everything is fresh", () => {
  const w = parseWindow({});
  assert.equal(w.start, null);
  assert.equal(w.end, null);
  assert.equal(isFresh("2019-01-01T00:00:00Z", w), true);
  assert.equal(isFresh(null, w), true);
});

test("unknown age counts as fresh even inside a window", () => {
  const w = parseWindow({ campaignStart: "2026-08-01" });
  assert.equal(isFresh(null, w), true);
  assert.equal(isFresh("not-a-date", w), true);
});

test("posts known to predate the campaign are excluded", () => {
  const w = parseWindow({ campaignStart: "2026-08-01" });
  assert.equal(isFresh("2026-07-31T23:00:00Z", w), false);
  assert.equal(isFresh("2026-08-02T10:00:00Z", w), true);
});

test("epoch seconds and ms are both accepted", () => {
  const w = parseWindow({ campaignStart: "2026-08-01" });
  assert.equal(isFresh(1754006400, w), true);      // 2026-08-01 in seconds
  assert.equal(isFresh(1754006400000, w), true);   // same in ms
  assert.equal(isFresh(1000000000, w), false);     // 2001, in seconds
});

test("campaignEnd excludes later posts", () => {
  const w = parseWindow({ campaignStart: "2026-08-01", campaignEnd: "2026-08-31" });
  assert.equal(isFresh("2026-09-05T00:00:00Z", w), false);
});

test("countFresh tallies over a list", () => {
  const w = parseWindow({ campaignStart: "2026-08-01" });
  const posts = [
    { takenAt: "2026-08-10T00:00:00Z" }, // fresh
    { takenAt: "2019-01-01T00:00:00Z" }, // old
    { takenAt: null },                    // unknown → fresh
  ];
  assert.equal(countFresh(posts, w), 2);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/freshness.test.js`
Expected: FAIL — cannot find module `../src/utils/freshness.js`.

- [ ] **Step 3: Implement**

```js
// src/utils/freshness.js
// Campaign-window freshness. Pure: no I/O, so both stores share one rule and it
// cannot drift between file and database modes.

// Accepts ISO string, epoch seconds, epoch ms, or Date. Returns a Date or null.
// Heuristic for numbers: < 1e12 is treated as seconds (ms since 1970 crossed 1e12
// in 2001, so any real post time in ms is well above it).
function toDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export function parseWindow({ campaignStart, campaignEnd } = {}) {
  return { start: toDate(campaignStart), end: toDate(campaignEnd) };
}

export function isFresh(takenAt, window = { start: null, end: null }) {
  const d = toDate(takenAt);
  if (!d) return true; // unknown age counts — never shrink counts silently
  if (window.start && d < window.start) return false;
  if (window.end && d > window.end) return false;
  return true;
}

export function countFresh(posts, window) {
  let n = 0;
  for (const p of posts) if (isFresh(p?.takenAt, window)) n += 1;
  return n;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/freshness.test.js`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add src/utils/freshness.js test/freshness.test.js
git commit -m "feat: campaign-window freshness helper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Config — new safety keys + campaignStart/End validation

**Files:**
- Modify: `src/config/index.js` (add safety keys ~line 34-35, 92-100; add campaign date validation in `validateHashtags`'s callers `writeBusiness`/`listBusinesses`/`readBusiness`)
- Modify: `config.json` (add the three new safety keys with defaults)
- Test: `test/config.test.js` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `loadGlobal().safety` now also carries `maxPostVisitsPerRun` (number), `pipelineTabs` (boolean), `journalRetentionDays` (number).
  - Business objects from `listBusinesses`/`readBusiness`/`loadConfig` now carry `campaignStart` (string|null) and `campaignEnd` (string|null).
  - `writeBusiness({ slug, name, hashtags, campaignStart?, campaignEnd? })` persists the two date fields; rejects invalid dates or `start > end`.
  - New export `validateCampaignDates(campaignStart, campaignEnd)` → `string[]` (problems).

- [ ] **Step 1: Write the failing tests** (append to `test/config.test.js`)

```js
import { validateCampaignDates } from "../src/config/index.js";

test("campaign dates: absent is valid", () => {
  assert.deepEqual(validateCampaignDates(undefined, undefined), []);
});

test("campaign dates: bad format is rejected", () => {
  const p = validateCampaignDates("not-a-date", undefined);
  assert.equal(p.length, 1);
});

test("campaign dates: start after end is rejected", () => {
  const p = validateCampaignDates("2026-09-01", "2026-08-01");
  assert.equal(p.length, 1);
});

test("campaign dates: valid range passes", () => {
  assert.deepEqual(validateCampaignDates("2026-08-01", "2026-08-31"), []);
});
```

Also add a global-safety test:

```js
import { loadGlobal } from "../src/config/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("loadGlobal exposes the new safety keys with defaults applied", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    mcpEndpoint: "http://127.0.0.1:12306/mcp",
    safety: {
      maxHashtagsPerRun: 12, maxRunMinutes: 60, scrollsPerHashtag: 5, pageLoadDelayMs: 6000,
      scrollPauseMs: [1, 2], gapBetweenHashtagsMs: [1, 2], initialDwellMs: [1, 2], startJitterMs: [0, 1],
    },
  }));
  const g = loadGlobal(root);
  assert.equal(typeof g.safety.maxPostVisitsPerRun, "number");
  assert.equal(typeof g.safety.pipelineTabs, "boolean");
  assert.equal(typeof g.safety.journalRetentionDays, "number");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/config.test.js`
Expected: FAIL — `validateCampaignDates` is not exported; new safety keys undefined.

- [ ] **Step 3: Implement**

In `src/config/index.js`:

Add a date regex and validator near the other regexes (after line 33):

```js
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateCampaignDates(campaignStart, campaignEnd) {
  const problems = [];
  const check = (label, v) => {
    if (v == null) return null;
    if (typeof v !== "string" || !DATE_RE.test(v) || isNaN(new Date(v).getTime())) {
      problems.push(`${label} must be an ISO date (YYYY-MM-DD) — got ${JSON.stringify(v)}`);
      return null;
    }
    return new Date(v);
  };
  const s = check("campaignStart", campaignStart);
  const e = check("campaignEnd", campaignEnd);
  if (s && e && s > e) problems.push("campaignStart must be on or before campaignEnd");
  return problems;
}
```

Make the new safety keys OPTIONAL with defaults so existing `config.json` keeps working. In `loadGlobal`, after the existing validation, before the `return`, build the safety object with fallbacks:

```js
  const OPT_NUM = { maxPostVisitsPerRun: 8, journalRetentionDays: 30 };
  for (const [key, def] of Object.entries(OPT_NUM)) {
    if (safety[key] === undefined) safety[key] = def;
    else if (typeof safety[key] !== "number" || safety[key] < 0) {
      problems.push(`safety.${key} must be a non-negative number`);
    }
  }
  if (safety.pipelineTabs === undefined) safety.pipelineTabs = true;
  else if (typeof safety.pipelineTabs !== "boolean") {
    problems.push("safety.pipelineTabs must be a boolean");
  }
```

(Place this block BEFORE the `if (problems.length) throw` check so violations are reported.) Then add the three keys to the returned `safety` object literal:

```js
      maxPostVisitsPerRun: safety.maxPostVisitsPerRun,
      pipelineTabs: safety.pipelineTabs,
      journalRetentionDays: safety.journalRetentionDays,
```

In `listBusinesses`, carry the two date fields through (in the `out.push({...})`):

```js
        campaignStart: raw.campaignStart ?? null,
        campaignEnd: raw.campaignEnd ?? null,
```

In `writeBusiness`, validate and persist the dates. After the hashtag validation:

```js
  const dateProblems = validateCampaignDates(campaignStart, campaignEnd);
  if (dateProblems.length) throw new Error(`invalid campaign dates:\n  - ${dateProblems.join("\n  - ")}`);
```

Add `campaignStart`/`campaignEnd` to the function's destructured params and to `payload`:

```js
    campaignStart: campaignStart ?? existing?.campaignStart ?? null,
    campaignEnd: campaignEnd ?? existing?.campaignEnd ?? null,
```

In `loadConfig`'s returned object, add:

```js
    campaignStart: chosen.campaignStart ?? null,
    campaignEnd: chosen.campaignEnd ?? null,
```

In `config.json`, add inside `safety`:

```json
    "maxPostVisitsPerRun": 8,
    "pipelineTabs": true,
    "journalRetentionDays": 30
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/config.test.js`
Expected: PASS. Also run full suite: `node --test test/` — Expected: no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/config/index.js config.json test/config.test.js
git commit -m "feat: config for post-visit cap, tab pipelining, journal retention, campaign dates

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Database migration 004 — rich post fields + fresh_posts

**Files:**
- Create: `db/migrations/004_rich_posts.sql`
- Modify: `src/stores/dbStore.js` (`record` insert/update; `writeRow` to persist `fresh_posts`)
- Test: none automated (DB tests are out of scope per README — the suite runs "no Chrome, no database"). Verify by SQL review + `npm run db:migrate` against a scratch DB if available.

**Interfaces:**
- Consumes: post records with `{id, url, imageUrl, caption, username, likeCount, commentCount, takenAt}` (from Task 6) and `text` (FB).
- Produces: `posts` rows carrying the rich fields; `tallies.fresh_posts` populated; `record` accepts a `window` and returns `{ newCount, freshCount, cumulative }`.

- [ ] **Step 1: Write the migration**

```sql
-- db/migrations/004_rich_posts.sql
-- Rich post fields (Instagram capture) + campaign-freshness tally column.
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

- [ ] **Step 2: Update `dbStore.record` to write rich fields, update-on-resight, and count fresh**

Change the signature to `async record(h, posts, _runAt, window)` and:
- Extend the INSERT column/value lists to include `username, caption, image_url, like_count, comment_count, taken_at`, and set `enriched_at` when the post already had a caption/username at capture time (pass through `post.enrichedAt ?? null`).
- Replace `do nothing` with an upsert that refreshes engagement and fills null-only fields:

```sql
on conflict (business, platform, hashtag, post_id) do update set
  like_count    = coalesce(excluded.like_count, posts.like_count),
  comment_count = coalesce(excluded.comment_count, posts.comment_count),
  caption       = coalesce(posts.caption, excluded.caption),
  username      = coalesce(posts.username, excluded.username),
  image_url     = coalesce(posts.image_url, excluded.image_url),
  taken_at      = coalesce(posts.taken_at, excluded.taken_at),
  enriched_at   = coalesce(excluded.enriched_at, posts.enriched_at)
```

- `newCount` must still count only genuinely NEW posts. `on conflict ... do update` returns a row even when nothing was inserted, so switch to detecting insert-vs-update via the `xmax = 0` trick:

```sql
insert into posts (...) values (...)
on conflict (...) do update set ... 
returning (xmax = 0) as inserted
```

Then `if (res.rows[0]?.inserted) newCount += 1;`.
- Compute `freshCount` in JS using `countFresh(posts.filter(isNew), window)` — but since we don't track per-post newness from SQL cheaply, compute fresh over the posts whose insert reported `inserted = true`. Collect those into an array during the loop and call `countFresh(newPosts, window)` from `src/utils/freshness.js`.
- Return `{ newCount, freshCount, cumulative }`.

- [ ] **Step 3: Update `dbStore.writeRow`** to accept and persist `row.freshCount`:

Add `fresh_posts` to the INSERT columns and the `on conflict do update set` list, bound to `row.freshCount ?? 0`.

- [ ] **Step 4: Verify SQL parses / migrates**

Run (only if a scratch Postgres is configured): `npm run db:migrate` then `npm run db:check`.
Expected: migration 004 applied, no error. If no DB available, review the SQL by eye and confirm column names match `dbStore.js` bindings exactly.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/004_rich_posts.sql src/stores/dbStore.js
git commit -m "feat: persist rich IG post fields and fresh-post tally in Postgres

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: File store — rich fields + fresh_posts

**Files:**
- Modify: `src/stores/tally.js` (`record` to accept `window`, write rich fields to JSONL, return `freshCount`; `writeRow` to append a `fresh_posts` column)
- Modify: `src/stores/fileStore.js` (thread `window` and `freshCount` through)
- Test: `test/tally.test.js` (append)

**Interfaces:**
- Consumes: `countFresh`/`parseWindow` from `src/utils/freshness.js`; post records with rich fields.
- Produces: `TallyStore.record(h, posts, runAt, window)` → `{ newCount, freshCount, cumulative }`; CSV gains a trailing `fresh_posts` column; JSONL lines carry the rich fields verbatim.

- [ ] **Step 1: Write the failing tests** (append to `test/tally.test.js`)

```js
import { parseWindow } from "../src/utils/freshness.js";

test("record returns freshCount honoring the campaign window", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tally-"));
  const store = new TallyStore(dir);
  const h = { platform: "instagram", value: "alpha" };
  const w = parseWindow({ campaignStart: "2026-08-01" });
  const posts = [
    { id: "ig:p/1", takenAt: "2026-08-10T00:00:00Z" }, // new + fresh
    { id: "ig:p/2", takenAt: "2019-01-01T00:00:00Z" }, // new but old
    { id: "ig:p/3", takenAt: null },                    // new, unknown → fresh
  ];
  const r = store.record(h, posts, "2026-08-25T00:00:00Z", w);
  assert.equal(r.newCount, 3);
  assert.equal(r.freshCount, 2);
  assert.equal(r.cumulative, 3);
});

test("rich fields are persisted to the posts jsonl", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tally-"));
  const store = new TallyStore(dir);
  const h = { platform: "instagram", value: "beta" };
  store.record(h, [{ id: "ig:p/9", username: "acme", likeCount: 42, caption: "hi" }], "2026-08-25T00:00:00Z", parseWindow({}));
  const line = fs.readFileSync(path.join(dir, "posts", "instagram-beta.jsonl"), "utf8").trim();
  const rec = JSON.parse(line);
  assert.equal(rec.username, "acme");
  assert.equal(rec.likeCount, 42);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/tally.test.js`
Expected: FAIL — `record` ignores `window`; `freshCount` undefined.

- [ ] **Step 3: Implement**

In `src/stores/tally.js`:
- `import { countFresh } from "../utils/freshness.js";`
- `record(h, posts, runAt, window = { start: null, end: null })`: after computing `fresh` (the new-to-us posts), also compute `const freshCount = countFresh(fresh, window);` and return `{ newCount: fresh.length, freshCount, cumulative: seenIds.size }`. The JSONL write already does `{ ...p, firstSeenAt: runAt }`, which carries rich fields through automatically — no change needed there beyond confirming.
- `writeRow(h, runAt, newCount, cumulative, status, freshCount = 0)`: append `freshCount` as a new trailing column. Update the CSV header in the constructor to `"...,cumulative_unique,fresh_posts,status\n"` — but note `status` must remain last only if nothing else parses by position. **`lastVisits()` parses columns 0-3 (runAt, date, platform, hashtag)**, which are unchanged, so appending fresh_posts before status is safe. Put `fresh_posts` between `cumulative_unique` and `status`:

Header: `"run_at,date,platform,hashtag,new_posts,cumulative_unique,fresh_posts,status\n"`
Row: `` `${runAt},${date},${h.platform},${h.value},${newCount},${cumulative},${freshCount},${status}\n` ``

In `src/stores/fileStore.js`:
- `record(h, posts, runAt, window)` → `return store.record(h, posts, runAt, window);`
- `writeRow(h, runAt, row)` → `store.writeRow(h, runAt, row.newCount, row.cumulative, row.status, row.freshCount);`

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/tally.test.js` then `node --test test/`
Expected: PASS, no regressions. (Existing tally tests call `record` with 3 args — `window` defaults, so they still pass; existing `writeRow` callers omit `freshCount` — defaults to 0.)

- [ ] **Step 5: Commit**

```bash
git add src/stores/tally.js src/stores/fileStore.js test/tally.test.js
git commit -m "feat: file store records rich post fields and fresh-post counts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Instagram capture — pure normalizer + in-page scripts

**Files:**
- Create: `src/services/capture.service.js` (the pure `normalizeCaptured` + `mergeRecords` functions AND the in-page script strings `IG_CAPTURE_INSTALL`, `IG_CAPTURE_HARVEST`, `IG_POST_EXTRACT`)
- Test: `test/capture.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalizeCaptured(raw)` → array of `{ id, url, imageUrl, caption, username, likeCount, commentCount, takenAt }`. `raw` is the object returned by the harvest script: `{ responses: [<parsedJson>...], inline: [<parsedJson>...] }`. Walks each blob for objects with a `code`/`shortcode` (or nested `media`), builds `id` as `ig:p/<shortcode>` (reels also `ig:p/` — matches DOM extractor which uses `p|reel`; see note), and extracts fields defensively (any missing field → null).
  - `mergeRecords(domPosts, capturedPosts)` → merged array keyed by `id`: DOM record is the base (guarantees presence), captured fields fill in; when both have a field, captured wins for `likeCount`/`commentCount`/`takenAt`, DOM wins for `url`.
  - `IG_CAPTURE_INSTALL` (string): idempotent patch of `fetch`/`XHR` storing matching responses in `window.__swCapture` (bounded).
  - `IG_CAPTURE_HARVEST` (string): returns `{ responses, inline }` parsed from the buffer + inline JSON scripts.
  - `IG_POST_EXTRACT` (string): returns one normalized-shape record from a post permalink page.

**Note on id shape:** the DOM extractor (`IG_EXTRACT`) builds ids as `ig:p/<code>` or `ig:reel/<code>`. `normalizeCaptured` cannot always tell reel from post, so it emits `ig:p/<code>`. `mergeRecords` must therefore match on the **shortcode**, not the full id: normalize both sides to their trailing `<code>` for the join, and keep the DOM record's id as canonical. Test this explicitly.

- [ ] **Step 1: Write the failing tests**

```js
// test/capture.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCaptured, mergeRecords } from "../src/services/capture.service.js";

const TAG_RESPONSE = {
  data: { recent: { sections: [{ layout_content: { medias: [
    { media: {
      code: "ABC123",
      like_count: 55, comment_count: 4, taken_at: 1754006400,
      user: { username: "acme_co" },
      caption: { text: "join our #campaign" },
      image_versions2: { candidates: [{ url: "https://img/1.jpg" }] },
    }},
  ]}}] } },
};

test("normalizeCaptured pulls fields from a tag response", () => {
  const recs = normalizeCaptured({ responses: [TAG_RESPONSE], inline: [] });
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.id, "ig:p/ABC123");
  assert.equal(r.username, "acme_co");
  assert.equal(r.likeCount, 55);
  assert.equal(r.commentCount, 4);
  assert.equal(r.caption, "join our #campaign");
  assert.equal(r.imageUrl, "https://img/1.jpg");
  assert.equal(r.takenAt, 1754006400);
});

test("normalizeCaptured tolerates junk and missing fields", () => {
  assert.deepEqual(normalizeCaptured({ responses: [null, 5, { nope: true }], inline: [] }), []);
  const recs = normalizeCaptured({ responses: [{ data: { recent: { sections: [
    { layout_content: { medias: [{ media: { code: "X" } }] } },
  ]}}}], inline: [] });
  assert.equal(recs[0].id, "ig:p/X");
  assert.equal(recs[0].likeCount, null);
});

test("mergeRecords matches on shortcode and keeps DOM id + url", () => {
  const dom = [{ id: "ig:reel/ABC123", url: "https://www.instagram.com/reel/ABC123/", preview: "alt" }];
  const captured = [{ id: "ig:p/ABC123", likeCount: 55, username: "acme_co", takenAt: 1754006400, imageUrl: "https://img/1.jpg", caption: "c" }];
  const merged = mergeRecords(dom, captured);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "ig:reel/ABC123");           // DOM id canonical
  assert.equal(merged[0].url, "https://www.instagram.com/reel/ABC123/");
  assert.equal(merged[0].likeCount, 55);                    // captured fills in
  assert.equal(merged[0].username, "acme_co");
});

test("mergeRecords keeps DOM-only posts the capture missed", () => {
  const dom = [{ id: "ig:p/ONLY", url: "u", preview: "alt" }];
  const merged = mergeRecords(dom, []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "ig:p/ONLY");
  assert.equal(merged[0].likeCount, null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/capture.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/services/capture.service.js
// Instagram enrichment. The pure functions (normalizeCaptured, mergeRecords) are
// unit-tested; the *_STRING scripts run in the tab via evalJs and are exercised
// end-to-end only against a live page.

const shortcodeOf = (id) => (typeof id === "string" ? id.split("/").pop() : null);

// Recursively find every object that looks like an IG media node.
function* walkMedia(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return;
  const m = node.media ?? node;
  if (m && typeof m === "object" && (m.code || m.shortcode)) yield m;
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    if (v && typeof v === "object") yield* walkMedia(v, depth + 1);
  }
}

function fieldFrom(m) {
  const code = m.code ?? m.shortcode;
  if (!code) return null;
  const img = m.image_versions2?.candidates?.[0]?.url
    ?? m.display_url
    ?? m.thumbnail_src
    ?? null;
  const num = (v) => (typeof v === "number" ? v : null);
  return {
    id: `ig:p/${code}`,
    url: null,
    imageUrl: img,
    caption: (typeof m.caption === "object" ? m.caption?.text : m.caption) ?? null,
    username: m.user?.username ?? m.owner?.username ?? null,
    likeCount: num(m.like_count),
    commentCount: num(m.comment_count),
    takenAt: num(m.taken_at) ?? m.taken_at_timestamp ?? null,
  };
}

export function normalizeCaptured(raw) {
  const blobs = [...(raw?.responses ?? []), ...(raw?.inline ?? [])];
  const byCode = new Map();
  for (const blob of blobs) {
    for (const m of walkMedia(blob)) {
      const rec = fieldFrom(m);
      if (!rec) continue;
      const code = shortcodeOf(rec.id);
      // A later, richer sighting overrides an earlier sparse one.
      const prev = byCode.get(code);
      byCode.set(code, prev ? { ...prev, ...clean(rec) } : rec);
    }
  }
  return [...byCode.values()];
}

// Drop null fields so a sparse later record doesn't wipe an earlier value.
function clean(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) if (v != null) out[k] = v;
  return out;
}

export function mergeRecords(domPosts, capturedPosts) {
  const capByCode = new Map(capturedPosts.map((c) => [shortcodeOf(c.id), c]));
  return domPosts.map((d) => {
    const c = capByCode.get(shortcodeOf(d.id));
    if (!c) return {
      id: d.id, url: d.url ?? null, imageUrl: null,
      caption: d.preview ?? null, username: null,
      likeCount: null, commentCount: null, takenAt: null, platform: "instagram",
    };
    return {
      id: d.id,                                   // DOM id is canonical (knows reel vs post)
      url: d.url ?? null,                          // DOM wins for url
      imageUrl: c.imageUrl ?? null,
      caption: c.caption ?? d.preview ?? null,
      username: c.username ?? null,
      likeCount: c.likeCount ?? null,             // captured wins
      commentCount: c.commentCount ?? null,
      takenAt: c.takenAt ?? null,
      platform: "instagram",
    };
  });
}

// --- in-page scripts (strings run via evalJs) ---

export const IG_CAPTURE_INSTALL = `
if (!window.__swCapture) {
  window.__swCapture = [];
  var MAX = 50, cap = window.__swCapture;
  var keep = function(url, text){
    if (!/\\/api\\/v1\\/tags\\/|\\/graphql\\/query|\\/api\\/v1\\/feed\\//.test(url)) return;
    if (!text || text.length > 2000000) return;
    cap.push(text);
    while (cap.length > MAX) cap.shift();
  };
  var of = window.fetch;
  window.fetch = function(){
    var args = arguments;
    return of.apply(this, args).then(function(res){
      try { var u = (args[0] && args[0].url) || args[0] || '';
        res.clone().text().then(function(t){ try { keep(String(u), t); } catch(e){} }); } catch(e){}
      return res;
    });
  };
  var oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u){ this.__swUrl = u; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(){
    var xhr = this;
    xhr.addEventListener('load', function(){ try { keep(String(xhr.__swUrl||''), xhr.responseText); } catch(e){} });
    return oSend.apply(this, arguments);
  };
}
return true;
`;

export const IG_CAPTURE_HARVEST = `
var responses = [];
(window.__swCapture || []).forEach(function(t){ try { responses.push(JSON.parse(t)); } catch(e){} });
var inline = [];
document.querySelectorAll('script[type="application/json"]').forEach(function(s){
  try { inline.push(JSON.parse(s.textContent)); } catch(e){}
});
return { responses: responses, inline: inline };
`;

export const IG_POST_EXTRACT = `
if (/\\/accounts\\/login/.test(location.href)) return { loggedOut: true };
var responses = [];
(window.__swCapture || []).forEach(function(t){ try { responses.push(JSON.parse(t)); } catch(e){} });
var inline = [];
document.querySelectorAll('script[type="application/json"]').forEach(function(s){
  try { inline.push(JSON.parse(s.textContent)); } catch(e){}
});
var og = function(p){ var el = document.querySelector('meta[property="'+p+'"]'); return el ? el.content : null; };
return { loggedOut: false, responses: responses, inline: inline,
  ogImage: og('og:image'), ogTitle: og('og:title') };
`;
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/capture.test.js` then `node --test test/`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/services/capture.service.js test/capture.test.js
git commit -m "feat: Instagram capture normalizer, record merge, in-page scripts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Enrichment queue selection helper

**Files:**
- Create: `src/services/enrich.service.js` (pure selection + a `enrichPost` runner using injectable deps)
- Test: `test/enrich.test.js`

**Interfaces:**
- Consumes: `IG_POST_EXTRACT` and `normalizeCaptured` from `capture.service.js`; merged records from Task 5.
- Produces:
  - `selectForEnrichment(records, cap)` → array (≤ cap) of records missing `takenAt` OR `caption` OR `username`, in input (discovery) order, Instagram only.
  - `enrichPost(client, record, deps)` → record augmented with any fields found on its permalink page; sets `enrichedAt`. `deps = { navigate, evalJs, assertSafe, sleep, pageLoadDelayMs, dwellMs, journal }`. Reads the post page via `IG_POST_EXTRACT`, runs `normalizeCaptured` on the result, matches by shortcode, and fills null-only fields; falls back to `ogImage` for `imageUrl`. Throws `BlockError` (via `assertSafe`) if the page is a wall — caller aborts.

- [ ] **Step 1: Write the failing tests**

```js
// test/enrich.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectForEnrichment, enrichPost } from "../src/services/enrich.service.js";

test("selects only records missing fields, capped, in order, IG only", () => {
  const recs = [
    { id: "ig:p/1", platform: "instagram", takenAt: 1, caption: "c", username: "u" }, // complete
    { id: "ig:p/2", platform: "instagram", takenAt: null, caption: "c", username: "u" }, // missing takenAt
    { id: "ig:p/3", platform: "instagram", takenAt: 1, caption: null, username: null }, // missing caption+user
    { id: "fb:c/9", platform: "facebook", takenAt: null }, // FB never enriched
  ];
  const chosen = selectForEnrichment(recs, 10);
  assert.deepEqual(chosen.map((r) => r.id), ["ig:p/2", "ig:p/3"]);
  assert.equal(selectForEnrichment(recs, 1).length, 1);
});

test("enrichPost fills null-only fields from the post page and stamps enrichedAt", async () => {
  const record = { id: "ig:p/ABC", platform: "instagram", takenAt: null, caption: null, username: null, imageUrl: null };
  const deps = {
    navigate: async () => {},
    assertSafe: async () => {},
    sleep: async () => {},
    pageLoadDelayMs: 0, dwellMs: 0,
    journal: { log: () => {} },
    evalJs: async () => ({
      loggedOut: false,
      responses: [{ data: { recent: { sections: [{ layout_content: { medias: [
        { media: { code: "ABC", like_count: 7, taken_at: 123, user: { username: "acme" }, caption: { text: "hello" } } },
      ]}}] } } }],
      inline: [], ogImage: "https://img/x.jpg",
    }),
  };
  const out = await enrichPost({ fake: true }, record, deps);
  assert.equal(out.username, "acme");
  assert.equal(out.caption, "hello");
  assert.equal(out.takenAt, 123);
  assert.equal(out.imageUrl, "https://img/x.jpg");
  assert.ok(out.enrichedAt);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/enrich.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/services/enrich.service.js
import { normalizeCaptured, IG_POST_EXTRACT } from "./capture.service.js";
import { BlockError } from "./safety.service.js";

const missing = (r) => r.takenAt == null || r.caption == null || r.username == null;

export function selectForEnrichment(records, cap) {
  const out = [];
  for (const r of records) {
    if (r.platform !== "instagram") continue;
    if (missing(r)) out.push(r);
    if (out.length >= cap) break;
  }
  return out;
}

const shortcode = (id) => (typeof id === "string" ? id.split("/").pop() : null);

export async function enrichPost(client, record, deps) {
  const { navigate, evalJs, assertSafe, sleep, pageLoadDelayMs, dwellMs, journal } = deps;
  const url = record.url || `https://www.instagram.com/p/${shortcode(record.id)}/`;
  journal?.log?.("post_visit", { platform: "instagram", detail: { id: record.id } });
  await navigate(client, url);
  await sleep(pageLoadDelayMs);
  await assertSafe(client, `enrich ${record.id}`);
  await sleep(dwellMs);

  const res = await evalJs(client, IG_POST_EXTRACT);
  if (res?.loggedOut) throw new BlockError(`not logged in during enrich ${record.id}`, { reason: "login_wall", url });

  const [found] = normalizeCaptured({ responses: res?.responses ?? [], inline: res?.inline ?? [] })
    .filter((r) => shortcode(r.id) === shortcode(record.id));
  const out = { ...record, enrichedAt: new Date().toISOString() };
  if (found) {
    for (const k of ["takenAt", "caption", "username", "imageUrl", "likeCount", "commentCount"]) {
      if (out[k] == null && found[k] != null) out[k] = found[k];
    }
  }
  if (out.imageUrl == null && res?.ogImage) out.imageUrl = res.ogImage;
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/enrich.test.js` then `node --test test/`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/services/enrich.service.js test/enrich.test.js
git commit -m "feat: capped post-page enrichment queue and runner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Forensic journal service

**Files:**
- Create: `src/services/journal.service.js`
- Test: `test/journal.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `createJournal({ root, runId, business, retentionDays })` → `{ log(action, data?), tail(n), path, dir }`. `log` appends one JSONL line `{ at, seq, action, platform?, hashtag?, detail? }` (seq increments; `at` is ISO). All writes try/caught — never throw. On creation it prunes journal files older than `retentionDays`.
  - `tail(n)` → array of the last `n` parsed entries (reads the file back; returns `[]` on any error).
  - `sanitizeRunId(runId)` → filesystem-safe basename (replace `:` and other illegal Windows chars with `-`).

- [ ] **Step 1: Write the failing tests**

```js
// test/journal.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJournal, sanitizeRunId } from "../src/services/journal.service.js";

test("sanitizeRunId strips characters illegal on Windows", () => {
  assert.equal(sanitizeRunId("2026-08-25T09:30:00.000Z"), "2026-08-25T09-30-00.000Z");
});

test("log appends ordered JSONL and tail reads the last N", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jrnl-"));
  const j = createJournal({ root, runId: "2026-08-25T00:00:00.000Z", business: "b", retentionDays: 30 });
  j.log("navigate", { platform: "instagram", hashtag: "alpha" });
  j.log("scroll", { detail: { step: 1 } });
  j.log("gap", { detail: { ms: 1000 } });
  const t = j.tail(2);
  assert.equal(t.length, 2);
  assert.equal(t[0].action, "scroll");
  assert.equal(t[1].action, "gap");
  assert.equal(t[1].seq, 3);
});

test("retention prunes old journal files but keeps recent ones", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jrnl-"));
  const dir = path.join(root, "data", "journal");
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, "old.jsonl");
  fs.writeFileSync(old, "{}\n");
  const past = Date.now() - 40 * 86400_000;
  fs.utimesSync(old, past / 1000, past / 1000);
  createJournal({ root, runId: "2026-08-25T00:00:00.000Z", business: "b", retentionDays: 30 });
  assert.equal(fs.existsSync(old), false);
});

test("a failing filesystem never throws from log", () => {
  const j = createJournal({ root: "/nonexistent-\0-root", runId: "x", business: "b", retentionDays: 30 });
  assert.doesNotThrow(() => j.log("navigate"));
  assert.deepEqual(j.tail(5), []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/journal.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/services/journal.service.js
import fs from "node:fs";
import path from "node:path";

export function sanitizeRunId(runId) {
  return String(runId).replace(/[:*?"<>|]/g, "-");
}

export function createJournal({ root, runId, business, retentionDays = 30 }) {
  const dir = path.join(root, "data", "journal");
  const file = path.join(dir, `${sanitizeRunId(runId)}.jsonl`);
  let seq = 0;

  try {
    fs.mkdirSync(dir, { recursive: true });
    // Prune old journals so months of daily runs don't accumulate unbounded.
    const cutoff = Date.now() - retentionDays * 86400_000;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }); } catch { /* skip */ }
    }
  } catch { /* journal is best-effort */ }

  const log = (action, data = {}) => {
    const entry = { at: new Date().toISOString(), seq: ++seq, action, ...data };
    try { fs.appendFileSync(file, JSON.stringify(entry) + "\n"); } catch { /* swallow */ }
  };

  const tail = (n) => {
    try {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
      return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  };

  log("run_start", { business, detail: { runId } });
  return { log, tail, path: file, dir };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/journal.test.js` then `node --test test/`
Expected: PASS. (Note: the `run_start` entry means the first test's seq counting starts at 1 for `run_start`; `navigate` is seq 2. Adjust the test's expected `t[1].seq` to `4` — recount: run_start=1, navigate=2, scroll=3, gap=4. **Fix the test to expect `seq === 4`** before Step 2, or drop the auto `run_start` log. Chosen: keep `run_start`; the test above must expect `t[1].seq === 4` and `t[0].action === "scroll"`, `t[1].action === "gap"` — update the literal accordingly.)

- [ ] **Step 5: Commit**

```bash
git add src/services/journal.service.js test/journal.test.js
git commit -m "feat: always-on forensic run journal with retention pruning

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Incident bundle service

**Files:**
- Create: `src/services/incident.service.js`
- Test: `test/incident.test.js`

**Interfaces:**
- Consumes: a journal's `tail(n)`; an MCP `client`; feature-detection flags.
- Produces:
  - `captureIncident({ root, runId, business, error, journal, client, caps, deps })` → `{ incidentDir }`. Writes `incident.json` (`{ at, runId, business, reason, url, context, tail }`), best-effort `page.txt` (via `deps.evalJs`) and `screenshot.png` (via `deps.screenshot` when `caps.screenshot`), and appends a line to `data/incidents/index.log`. Every write independently try/caught; returns the dir even if extras fail.
  - `deps = { evalJs, screenshot }`, both optional/injectable for tests.

- [ ] **Step 1: Write the failing tests**

```js
// test/incident.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureIncident } from "../src/services/incident.service.js";
import { BlockError } from "../src/services/safety.service.js";

test("writes incident.json with reason, url and journal tail", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inc-"));
  const journal = { tail: () => [{ action: "navigate" }, { action: "danger" }] };
  const err = new BlockError("checkpoint at x", { reason: "checkpoint", url: "https://x/checkpoint" });
  const { incidentDir } = await captureIncident({
    root, runId: "2026-08-25T00:00:00.000Z", business: "b", error: err, journal,
    client: { fake: true }, caps: { screenshot: false },
    deps: { evalJs: async () => "PAGE TEXT" },
  });
  const bundle = JSON.parse(fs.readFileSync(path.join(incidentDir, "incident.json"), "utf8"));
  assert.equal(bundle.reason, "checkpoint");
  assert.equal(bundle.url, "https://x/checkpoint");
  assert.equal(bundle.tail.length, 2);
  assert.equal(fs.readFileSync(path.join(incidentDir, "page.txt"), "utf8"), "PAGE TEXT");
  const index = fs.readFileSync(path.join(root, "data", "incidents", "index.log"), "utf8");
  assert.match(index, /checkpoint/);
});

test("a failing page-text grab still yields a bundle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inc-"));
  const journal = { tail: () => [] };
  const { incidentDir } = await captureIncident({
    root, runId: "2026-08-25T00:00:00.000Z", business: "b",
    error: new Error("plain"), journal, client: {}, caps: { screenshot: false },
    deps: { evalJs: async () => { throw new Error("no page"); } },
  });
  assert.ok(fs.existsSync(path.join(incidentDir, "incident.json")));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/incident.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/services/incident.service.js
import fs from "node:fs";
import path from "node:path";
import { sanitizeRunId } from "./journal.service.js";

const PAGE_TEXT = `return (document.body ? document.body.innerText : '').slice(0, 50000);`;

export async function captureIncident({ root, runId, business, error, journal, client, caps = {}, deps = {} }) {
  const base = path.join(root, "data", "incidents");
  const incidentDir = path.join(base, sanitizeRunId(runId));
  const reason = error?.reason ?? "unknown";
  const url = error?.url ?? null;

  try { fs.mkdirSync(incidentDir, { recursive: true }); } catch { /* best effort */ }

  const bundle = {
    at: new Date().toISOString(), runId, business, reason, url,
    context: error?.message ?? String(error), tail: (() => { try { return journal?.tail?.(50) ?? []; } catch { return []; } })(),
  };
  try { fs.writeFileSync(path.join(incidentDir, "incident.json"), JSON.stringify(bundle, null, 2)); } catch { /* swallow */ }

  // Best-effort page text.
  try {
    if (deps.evalJs) {
      const text = await deps.evalJs(client, PAGE_TEXT);
      if (typeof text === "string") fs.writeFileSync(path.join(incidentDir, "page.txt"), text);
    }
  } catch { /* swallow */ }

  // Best-effort screenshot (only if the tool exists).
  try {
    if (caps.screenshot && deps.screenshot) {
      const png = await deps.screenshot(client);
      if (png) fs.writeFileSync(path.join(incidentDir, "screenshot.png"), png);
    }
  } catch { /* swallow */ }

  try {
    fs.mkdirSync(base, { recursive: true });
    fs.appendFileSync(path.join(base, "index.log"),
      `${bundle.at}\t${business}\t${runId}\t${reason}\t${url ?? ""}\n`);
  } catch { /* swallow */ }

  return { incidentDir };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/incident.test.js` then `node --test test/`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/services/incident.service.js test/incident.test.js
git commit -m "feat: incident bundle on danger signals (reason, page text, screenshot, action tail)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Tab pipeline + capabilities detection in mcp/safety layer

**Files:**
- Modify: `src/services/mcp.service.js` (add `detectCaps`, `screenshot`, minimal tab helpers)
- Modify: `src/services/safety.service.js` (add `humanScroll` optional journal param — non-breaking)
- Test: `test/pipeline.test.js` (tests the pure scheduler decision, not live Chrome)
- Create: `src/services/pipeline.service.js` (pure decision helper)

**Interfaces:**
- Consumes: `client.listTools()`.
- Produces:
  - `detectCaps(client)` → `{ tabs: boolean, screenshot: boolean }` by scanning tool names (tabs need whatever mcp-chrome exposes for open/switch/close — match by name substring `tab`; screenshot by substring `screenshot`).
  - `openTab(client, url)`, `switchTab(client, target)`, `closeTab(client, target)` — thin `callTool` wrappers using the detected tool names (resolved once and passed in), each try/caught by the caller.
  - `screenshot(client)` → Buffer|null.
  - `pipeline.service.js`: `planNext({ index, targets, caps, downgraded })` → `{ preload: boolean, url: string|null }` — decides whether to pre-open the next hashtag during the gap (only when `caps.tabs && !downgraded && index < targets.length - 1`).

- [ ] **Step 1: Write the failing test** (pure scheduler)

```js
// test/pipeline.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { planNext } from "../src/services/pipeline.service.js";

const targets = [
  { platform: "instagram", value: "a" },
  { platform: "instagram", value: "b" },
];

test("preloads the next tab when tabs are supported", () => {
  const p = planNext({ index: 0, targets, caps: { tabs: true }, downgraded: false });
  assert.equal(p.preload, true);
  assert.match(p.url, /explore\/tags\/b/);
});

test("no preload without tab support", () => {
  assert.equal(planNext({ index: 0, targets, caps: { tabs: false }, downgraded: false }).preload, false);
});

test("no preload after a downgrade", () => {
  assert.equal(planNext({ index: 0, targets, caps: { tabs: true }, downgraded: true }).preload, false);
});

test("no preload on the last hashtag", () => {
  assert.equal(planNext({ index: 1, targets, caps: { tabs: true }, downgraded: false }).preload, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/pipeline.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/services/pipeline.service.js
import { hashtagUrl } from "../config/index.js";

export function planNext({ index, targets, caps, downgraded }) {
  const canPreload = !!caps?.tabs && !downgraded && index < targets.length - 1;
  const next = canPreload ? targets[index + 1] : null;
  return { preload: canPreload, url: next ? hashtagUrl({ platform: next.platform, value: next.value }) : null };
}
```

In `src/services/mcp.service.js` add:

```js
export async function detectCaps(client) {
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name.toLowerCase());
    return {
      tabs: names.some((n) => n.includes("tab")),
      screenshot: names.some((n) => n.includes("screenshot")),
      // resolved tool names for the tab ops, best-effort:
      names,
    };
  } catch {
    return { tabs: false, screenshot: false, names: [] };
  }
}

export async function screenshot(client) {
  try {
    const res = await client.callTool({ name: "chrome_screenshot", arguments: {} });
    const img = (res.content ?? []).find((c) => c.type === "image");
    return img?.data ? Buffer.from(img.data, "base64") : null;
  } catch { return null; }
}
```

For tab helpers, keep them thin and defensive — the exact mcp-chrome tool names are resolved at runtime (`chrome_navigate` with a `newTab`/`createTab` arg if that's what the bridge exposes; otherwise a dedicated tab tool). Because the precise API is bridge-version-dependent, the run loop (Task 10) treats **any** tab-op failure as a downgrade signal. Implement:

```js
// Open url in a background tab. Returns true on success. Bridge-name tolerant.
export async function openTab(client, url) {
  // mcp-chrome exposes navigation; some builds accept an active:false / newWindow flag.
  await callTool(client, "chrome_navigate", { url, newTab: true });
  return true;
}
```

(If `chrome_navigate` rejects the `newTab` arg on the installed bridge, the caller catches and downgrades — this is by design and covered by the downgrade path, not a unit test.)

In `src/services/safety.service.js`, make `humanScroll` accept an optional journal without breaking existing callers:

```js
export async function humanScroll(client, { steps, scrollPauseMs }, journal) {
  for (let i = 0; i < steps; i++) {
    await evalJs(client, "window.scrollBy(0, Math.round(window.innerHeight * (0.7 + Math.random() * 0.4))); return true;").catch(() => {});
    journal?.log?.("scroll", { detail: { step: i + 1 } });
    await jitter(scrollPauseMs);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/pipeline.test.js` then `node --test test/`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/services/pipeline.service.js src/services/mcp.service.js src/services/safety.service.js test/pipeline.test.js
git commit -m "feat: capability detection, tab helpers, and pure pipeline scheduler

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Wire everything into the run loop

**Files:**
- Modify: `src/services/run.service.js` (`collect` and `run`)
- Modify: `test/run.test.js` (extend deps shape; add integration-ish assertions with fakes)

**Interfaces:**
- Consumes: `createJournal`, `captureIncident`, `detectCaps`/`screenshot`/`openTab`, `planNext`, capture scripts + `mergeRecords`, `selectForEnrichment`/`enrichPost`, `parseWindow`.
- Produces: `collect(client, h, safety, { journal, caps })` now installs capture, harvests, merges, and returns merged IG records; `run` builds the window from `config.campaignStart/End`, passes it to `store.record`, runs the enrichment phase, journals every step, and writes an incident bundle on `BlockError`.

- [ ] **Step 1: Write the failing test** (extend `test/run.test.js`)

```js
test("run passes rich records through and reports freshCount in hashtag_done", async () => {
  const config = fastConfig([{ platform: "instagram", value: "alpha" }]);
  config.campaignStart = "2026-08-01";
  const events = [];
  await run({
    config,
    onEvent: (e) => events.push(e),
    deps: deps(async () => [
      { id: "ig:p/1", platform: "instagram", takenAt: "2026-08-10T00:00:00Z" },
      { id: "ig:p/2", platform: "instagram", takenAt: "2019-01-01T00:00:00Z" },
    ]),
  });
  const done = events.find((e) => e.type === "hashtag_done");
  assert.equal(done.newCount, 2);
  assert.equal(done.freshCount, 1);
});
```

(Because `collect` is injected via `deps.collect` in tests, the capture/merge machinery is bypassed there; the real `collect` is exercised only against live Chrome. The test verifies the freshness wiring end-to-end through the store.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/run.test.js`
Expected: FAIL — `hashtag_done` has no `freshCount`; `record` called without window.

- [ ] **Step 3: Implement**

In `run.service.js`:

Imports:

```js
import { IG_EXTRACT, FB_EXTRACT } from "./extract.service.js";
import { IG_CAPTURE_INSTALL, IG_CAPTURE_HARVEST, normalizeCaptured, mergeRecords } from "./capture.service.js";
import { selectForEnrichment, enrichPost } from "./enrich.service.js";
import { createJournal } from "./journal.service.js";
import { captureIncident } from "./incident.service.js";
import { detectCaps, screenshot as mcpScreenshot, openTab } from "./mcp.service.js";
import { planNext } from "./pipeline.service.js";
import { parseWindow } from "../utils/freshness.js";
```

Rewrite `collect` for Instagram capture (Facebook path unchanged):

```js
export async function collect(client, h, safety, ctx = {}) {
  const { journal, preloaded } = ctx;
  if (!preloaded) {
    await navigate(client, hashtagUrl(h));
    journal?.log?.("navigate", { platform: h.platform, hashtag: h.value });
  } else {
    journal?.log?.("tab_switch", { platform: h.platform, hashtag: h.value });
  }
  await sleep(safety.pageLoadDelayMs);
  await assertSafe(client, `${h.platform}#${h.value} load`);

  if (h.platform === "instagram") {
    await evalJs(client, IG_CAPTURE_INSTALL).catch(() => {});
  }
  await jitter(safety.initialDwellMs);
  journal?.log?.("dwell", { platform: h.platform, hashtag: h.value });
  await humanScroll(client, { steps: safety.scrollsPerHashtag, scrollPauseMs: safety.scrollPauseMs }, journal);
  await assertSafe(client, `${h.platform}#${h.value} after-scroll`);

  const res = await evalJs(client, h.platform === "instagram" ? IG_EXTRACT : FB_EXTRACT);
  if (res.loggedOut) throw new BlockError(`not logged in to ${h.platform}`, { reason: "login_wall", url: hashtagUrl(h) });

  if (h.platform === "instagram") {
    let captured = [];
    try {
      const raw = await evalJs(client, IG_CAPTURE_HARVEST);
      captured = normalizeCaptured(raw);
    } catch { /* degrade to DOM-only */ }
    journal?.log?.("capture_harvest", { platform: h.platform, hashtag: h.value, detail: { records: captured.length } });
    return mergeRecords(res.posts, captured);
  }
  journal?.log?.("extract", { platform: h.platform, hashtag: h.value, detail: { posts: res.posts.length } });
  return res.posts;
}
```

In `run`, after `const S = config.safety;`:

```js
const window = parseWindow({ campaignStart: config.campaignStart, campaignEnd: config.campaignEnd });
const journal = createJournal({ root: config.root, runId: runAt, business: config.business, retentionDays: S.journalRetentionDays });
let caps = { tabs: false, screenshot: false };
let downgraded = false;
const enrichQueue = [];
```

After `client = await cx(...)`:

```js
caps = await detectCaps(client).catch(() => ({ tabs: false, screenshot: false }));
if (!S.pipelineTabs) caps.tabs = false;
```

Change the collect call and post-recording:

```js
const posts = await co(client, h, S, { journal, caps, preloaded: h.__preloaded });
const { newCount, freshCount, cumulative } = await results.record(h, posts, runAt, window);
// queue IG records still missing fields for the enrichment phase
for (const p of selectForEnrichment(posts, S.maxPostVisitsPerRun - enrichQueue.length)) enrichQueue.push({ ...p, hashtag: h });
```

Add `freshCount` to the `writeRow` row object and the `hashtag_done` event.

In the gap block, add pipelining:

```js
if (i < targets.length - 1) {
  const plan = planNext({ index: i, targets, caps, downgraded });
  if (plan.preload) {
    try { await openTab(client, plan.url); targets[i + 1].__preloaded = true; journal?.log?.("tab_open", { detail: { url: plan.url } }); }
    catch { downgraded = true; journal?.log?.("downgrade", { detail: { reason: "tab_open_failed" } }); }
  }
  const gapMs = rand(S.gapBetweenHashtagsMs[0], S.gapBetweenHashtagsMs[1]);
  journal?.log?.("gap", { detail: { ms: gapMs }, });
  emit("waiting", { seconds: Math.round(gapMs / 1000), next: asTarget(targets[i + 1]) });
  await delay(gapMs, undefined, { signal }).catch(() => {});
}
```

After the hashtag loop, before `finally`, add the enrichment phase (respecting the deadline and abort):

```js
if (client && enrichQueue.length && !signal?.aborted && Date.now() <= deadline) {
  const enrichDeps = {
    navigate, evalJs, assertSafe, sleep,
    pageLoadDelayMs: S.pageLoadDelayMs, dwellMs: rand(S.initialDwellMs[0], S.initialDwellMs[1]), journal,
  };
  for (const rec of enrichQueue.slice(0, S.maxPostVisitsPerRun)) {
    if (signal?.aborted || Date.now() > deadline) break;
    try {
      const enriched = await enrichPost(client, rec, enrichDeps);
      await results.record(rec.hashtag, [enriched], runAt, window); // upsert fills fields
    } catch (err) {
      if (err instanceof BlockError) {
        status = "aborted"; abortReason = err.reason ?? "unknown";
        try { const { incidentDir } = await captureIncident({ root: config.root, runId: runAt, business: config.business, error: err, journal, client, caps, deps: { evalJs, screenshot: mcpScreenshot } }); emit("danger", { reason: abortReason, url: err.url ?? null, message: err.message, incidentDir }); } catch { /* swallow */ }
        break;
      }
      journal?.log?.("post_visit", { detail: { id: rec.id, error: err.message } });
    }
    const gapMs = rand(S.gapBetweenHashtagsMs[0], S.gapBetweenHashtagsMs[1]);
    await delay(gapMs, undefined, { signal }).catch(() => {});
  }
}
```

In the hashtag-loop `catch (err instanceof BlockError)` branch, ALSO write an incident bundle before `emit("danger", ...)`:

```js
let incidentDir = null;
try { ({ incidentDir } = await captureIncident({ root: config.root, runId: runAt, business: config.business, error: err, journal, client, caps, deps: { evalJs, screenshot: mcpScreenshot } })); } catch { /* swallow */ }
```

and add `incidentDir` to the emitted `danger` event.

Add `journal?.log?.("run_end", { detail: { status } });` right before `emit("run_finished", ...)`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/run.test.js` then the full suite `node --test test/`
Expected: PASS. Existing run tests use `deps.collect` (bypassing capture) and call with 4th arg `window` defaulting inside stores — confirm no regression. The new test asserts `freshCount === 1`.

- [ ] **Step 5: Commit**

```bash
git add src/services/run.service.js test/run.test.js
git commit -m "feat: wire capture, freshness, enrichment, journal, incidents, and tab pipelining into the run loop

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: CLI printer + supervisor event surfacing

**Files:**
- Modify: `bin/cli.js` (print `freshCount`, capture-degraded note, incident path on danger)
- Modify: `src/services/supervisor.service.js` (thread `campaignStart/End` are already in config via `loadConfig`; ensure `targets` mapping unaffected — verify only)
- Test: none (printing only); verify by reading.

**Interfaces:**
- Consumes: run events with `freshCount`, `incidentDir`.
- Produces: human-readable CLI lines including fresh counts and the incident directory when a run aborts.

- [ ] **Step 1: Update the printer**

In `bin/cli.js` `hashtag_done` case:

```js
      case "hashtag_done":
        console.log(
          `  ${e.platform} #${e.hashtag}: ${e.postsOnPage} on page, +${e.newCount} new (${e.freshCount ?? e.newCount} in-campaign), ${e.cumulative} total`,
        );
        break;
```

In the `danger` case, add the incident path:

```js
      case "danger":
        console.error(`  DANGER: ${e.message} — aborting the whole run (no retry).`);
        if (e.incidentDir) console.error(`  incident saved: ${e.incidentDir}`);
        break;
```

- [ ] **Step 2: Verify supervisor is unaffected**

Read `src/services/supervisor.service.js` lines around 122-145. `loadConfig({ business })` now returns `campaignStart/End`; `config` is passed whole into `run`, so no change is needed. Confirm the `targets` map (line 134) still uses `h.value` → `hashtag` (unchanged). No edit unless a mismatch is found.

- [ ] **Step 3: Run the full suite**

Run: `node --test test/`
Expected: PASS (no behavior change to tested code).

- [ ] **Step 4: Commit**

```bash
git add bin/cli.js
git commit -m "feat: CLI shows in-campaign counts and incident path on abort

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Documentation

**Files:**
- Modify: `README.md` (rich fields, campaign dates, throughput, journal/incidents, config keys, `data/` layout, migration note)
- Modify: `ANTIBAN.md` (new section: why pipelined-sequential is safe and same-account parallel is not; enrichment visits are capped and human-paced; journal/incidents)
- Modify: `.gitignore` (ensure `data/journal/` and `data/incidents/` are ignored like other `data/`)

**Interfaces:** docs only.

- [ ] **Step 1: Update README**

Add to the `data/` layout description: `journal/<runId>.jsonl` (forensic action log, 30-day retention) and `incidents/<runId>/` (bundle written on any danger sign) + `incidents/index.log`. Document the new `safety` keys (`maxPostVisitsPerRun`, `pipelineTabs`, `journalRetentionDays`) and per-business `campaignStart`/`campaignEnd`. Update the Instagram platform note to mention captured like/username/caption/image/taken-at and the capped post-visit enrichment fallback. Add a line to run `npm run db:migrate` for migration 004.

- [ ] **Step 2: Update ANTIBAN.md**

Add a subsection under the rules explaining: (a) tab pipelining pre-navigates the next hashtag during the existing gap but never scrolls two tabs at once, so it does not raise concurrent activity; (b) enrichment visits are capped (`maxPostVisitsPerRun`, default 8), human-paced with the same jitter and danger checks, and abort-never-retry; (c) the journal + incident bundle exist to detect and diagnose any flag, per §"If something does go wrong"; (d) same-account parallel scraping was considered and rejected as a behavioral bot signature.

- [ ] **Step 3: Update .gitignore**

Confirm `data/` (or the specific subdirs) is ignored so journals/incidents/screenshots are never committed. If `data/` is already ignored wholesale, no change needed — verify.

- [ ] **Step 4: Commit**

```bash
git add README.md ANTIBAN.md .gitignore
git commit -m "docs: rich fields, campaign window, pipelined throughput, and ban forensics

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §1 rich fields — Tasks 3, 4, 5, 6, 10 ✓
- §1 hybrid enrichment cap — Task 6, 10 ✓
- §2 freshness window + unknown-age rule — Tasks 1, 2, 3, 4, 10 ✓
- §3 longer scrolls + pipeline, one-tab-active, downgrade — Tasks 2 (config), 9, 10 ✓
- §3 rejected same-account parallel — Task 12 (ANTIBAN) ✓
- §4 journal + retention — Task 7 ✓
- §4 incident bundle + index + SSE pointer — Tasks 8, 10 ✓
- Dedup unchanged — verified: Tasks 3/4 keep conflict-keyed insert / seen.json ✓
- Schema migration 004 — Task 3 ✓
- Docs — Task 12 ✓
- Testing (unit only, node:test) — every code task has tests except doc/printer tasks ✓

**Placeholder scan:** No TBD/TODO; every code step has concrete code. One self-correction embedded in Task 7 Step 4 (the `run_start` auto-log shifts seq; the test literal must expect `seq === 4`) — flagged inline so the executor fixes the test before running it.

**Type consistency:**
- Record shape `{ id, url, imageUrl, caption, username, likeCount, commentCount, takenAt }` used identically across Tasks 5, 6, 10 ✓
- `record(h, posts, runAt, window)` → `{ newCount, freshCount, cumulative }` consistent across Tasks 3, 4, 10 ✓
- `writeRow` row gains `freshCount` — Tasks 3, 4, 10 agree ✓
- `journal.log(action, data)` / `journal.tail(n)` consistent across Tasks 7, 8, 9, 10 ✓
- `planNext({ index, targets, caps, downgraded })` consistent Tasks 9, 10 ✓
- `captureIncident({ root, runId, business, error, journal, client, caps, deps })` consistent Tasks 8, 10 ✓

One open risk (documented, not a plan defect): the exact mcp-chrome tab-tool API is bridge-version-dependent. The plan handles this by treating any tab-op failure as a downgrade (Task 9/10), so an unknown tool name degrades gracefully rather than breaking a run — the safe default per the Global Constraints.
