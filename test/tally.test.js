import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TallyStore } from "../src/stores/tally.js";
import { parseWindow } from "../src/utils/freshness.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tally-test-"));
}

/**
 * REGRESSION TEST — do not delete.
 *
 * Dedup memory is keyed per hashtag, and the same post legitimately appears
 * under several hashtags. In the real campaign data, 174 tallied records are
 * only 159 distinct posts. Anything that dedups globally (e.g. a DB upsert
 * conflicting on (platform, post_id) alone) silently under-counts every
 * hashtag processed after the first.
 */
test("the same post counts as new under each separate hashtag", () => {
  const dir = tmpDir();
  const store = new TallyStore(dir);
  const post = { platform: "instagram", id: "ig:p/SHARED", url: "u", preview: "p" };

  const first = store.record({ platform: "instagram", value: "weddingsph" }, [post], "T1");
  const second = store.record(
    { platform: "instagram", value: "weddingphilippines" },
    [post],
    "T1",
  );

  assert.equal(first.newCount, 1, "new under the first hashtag");
  assert.equal(second.newCount, 1, "new under the second hashtag too");
  assert.equal(first.cumulative, 1);
  assert.equal(second.cumulative, 1);
});

test("a repeat of the same post under the same hashtag is not new", () => {
  const dir = tmpDir();
  const store = new TallyStore(dir);
  const h = { platform: "instagram", value: "weddingsph" };
  const post = { platform: "instagram", id: "ig:p/ONE", url: "u", preview: null };

  assert.equal(store.record(h, [post], "T1").newCount, 1);
  const again = store.record(h, [post], "T2");
  assert.equal(again.newCount, 0, "already seen");
  assert.equal(again.cumulative, 1, "cumulative does not double-count");
});

test("lastVisits reports the newest run per hashtag", () => {
  const dir = tmpDir();
  const store = new TallyStore(dir);
  const a = { platform: "instagram", value: "alpha" };
  const b = { platform: "facebook", value: "beta" };
  store.writeRow(a, "2026-08-20T01:00:00.000Z", 1, 1, "ok");
  store.writeRow(a, "2026-08-22T01:00:00.000Z", 0, 1, "ok");
  store.writeRow(b, "2026-08-21T01:00:00.000Z", 2, 2, "ok");

  assert.deepEqual(store.lastVisits(), {
    "instagram:alpha": "2026-08-22T01:00:00.000Z",
    "facebook:beta": "2026-08-21T01:00:00.000Z",
  });
});

test("lastVisits on a fresh store is empty, not an error", () => {
  const store = new TallyStore(tmpDir());
  assert.deepEqual(store.lastVisits(), {});
});

test("cumulative accumulates across runs and rows land in the csv", () => {
  const dir = tmpDir();
  const store = new TallyStore(dir);
  const h = { platform: "facebook", value: "weddingsph" };

  const r1 = store.record(h, [{ id: "fb:c1" }, { id: "fb:c2" }], "T1");
  store.writeRow(h, "2026-08-24T14:16:49.385Z", r1.newCount, r1.cumulative, "ok");
  const r2 = store.record(h, [{ id: "fb:c2" }, { id: "fb:c3" }], "T2");
  store.writeRow(h, "2026-08-25T14:16:49.385Z", r2.newCount, r2.cumulative, "ok");
  store.save();

  assert.equal(r2.newCount, 1, "only fb:c3 is new");
  assert.equal(r2.cumulative, 3);

  const csv = fs.readFileSync(path.join(dir, "tally.csv"), "utf8").trim().split("\n");
  assert.equal(csv[0], "run_at,date,platform,hashtag,new_posts,cumulative_unique,fresh_posts,status");
  assert.equal(csv[1], "2026-08-24T14:16:49.385Z,2026-08-24,facebook,weddingsph,2,2,0,ok");
  assert.equal(csv[2], "2026-08-25T14:16:49.385Z,2026-08-25,facebook,weddingsph,1,3,0,ok");

  const seen = JSON.parse(fs.readFileSync(path.join(dir, "seen.json"), "utf8"));
  assert.deepEqual(seen["facebook:weddingsph"], ["fb:c1", "fb:c2", "fb:c3"]);
});

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

/**
 * REGRESSION TEST — do not delete.
 *
 * Critical 2 (Task 10 review): the enrichment phase must persist through
 * `enrichPost`, never `record` — `record` dedups by id and would silently
 * discard a post already in seen.json, which is exactly what happened before
 * this method existed. This locks the file-store persistence path in with a
 * direct unit test, independent of the run-loop mocks in run.test.js.
 */
test("enrichPost merges fields into the existing jsonl line", () => {
  const dir = tmpDir();
  const store = new TallyStore(dir);
  const h = { platform: "instagram", value: "alpha" };
  const w = parseWindow({});

  const first = store.record(
    h,
    [{ id: "ig:p/1", platform: "instagram", caption: null, username: null, takenAt: null, likeCount: null }],
    "T1",
    w,
  );
  assert.equal(first.newCount, 1, "the DOM-only sighting is recorded as new");

  store.enrichPost(h, {
    id: "ig:p/1",
    caption: "hello",
    username: "acme",
    takenAt: "2026-08-10T00:00:00Z",
    likeCount: 42,
  });

  const jsonlPath = path.join(dir, "posts", "instagram-alpha.jsonl");
  const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const enriched = lines.find((r) => r.id === "ig:p/1");
  assert.ok(enriched, "the enriched line is still present");
  assert.equal(enriched.caption, "hello");
  assert.equal(enriched.username, "acme");
  assert.equal(enriched.takenAt, "2026-08-10T00:00:00Z");
  assert.equal(enriched.likeCount, 42);
  assert.ok(enriched.enrichedAt, "enrichedAt is stamped");

  // Enrichment must not touch dedup memory: still exactly one id, and a
  // repeat sighting of the same post is still deduped as not-new.
  store.save();
  const seen = JSON.parse(fs.readFileSync(path.join(dir, "seen.json"), "utf8"));
  assert.deepEqual(seen["instagram:alpha"], ["ig:p/1"]);
  const second = store.record(h, [{ id: "ig:p/1", platform: "instagram" }], "T2", w);
  assert.equal(second.newCount, 0, "still deduped after enrichment");
  assert.equal(second.cumulative, 1, "enrichment did not add or remove ids");

  // Defensive: enriching an id that was never recorded is a silent no-op.
  assert.doesNotThrow(() => store.enrichPost(h, { id: "ig:p/DOESNOTEXIST", caption: "x" }));
  const linesAfter = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
  assert.equal(linesAfter.length, 1, "no phantom line was added for the unmatched id");
});

test("fileStore.seenIds returns every recorded id for the hashtag", async () => {
  const { createFileStore } = await import("../src/stores/fileStore.js");
  const dir = tmpDir();
  const store = createFileStore(dir);
  const h = { platform: "instagram", value: "frontier" };
  await store.record(h, [{ id: "ig:p/A" }, { id: "ig:p/B" }], "T1");
  await store.record(h, [{ id: "ig:p/B" }, { id: "ig:p/C" }], "T2");

  const ids = await store.seenIds(h);
  assert.deepEqual([...ids].sort(), ["ig:p/A", "ig:p/B", "ig:p/C"]);
  assert.deepEqual(await store.seenIds({ platform: "instagram", value: "other" }), []);
});
