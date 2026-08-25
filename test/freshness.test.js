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
  assert.equal(isFresh(1785542400, w), true);      // 2026-08-01 in seconds
  assert.equal(isFresh(1785542400000, w), true);   // same in ms
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
