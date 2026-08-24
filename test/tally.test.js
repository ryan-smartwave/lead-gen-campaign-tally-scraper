import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TallyStore } from "../src/stores/tally.js";

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
  assert.equal(csv[0], "run_at,date,platform,hashtag,new_posts,cumulative_unique,status");
  assert.equal(csv[1], "2026-08-24T14:16:49.385Z,2026-08-24,facebook,weddingsph,2,2,ok");
  assert.equal(csv[2], "2026-08-25T14:16:49.385Z,2026-08-25,facebook,weddingsph,1,3,ok");

  const seen = JSON.parse(fs.readFileSync(path.join(dir, "seen.json"), "utf8"));
  assert.deepEqual(seen["facebook:weddingsph"], ["fb:c1", "fb:c2", "fb:c3"]);
});
