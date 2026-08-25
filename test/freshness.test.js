import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWindow, isFresh, countFresh, toIso } from "../src/utils/freshness.js";

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

// FIX 1 (CRITICAL): `taken_at` is a timestamptz column. Binding a raw
// epoch-seconds number (IG's native format for takenAt) throws "date/time
// field value out of range" the first time capture returns a timestamp.
// `toIso` is what the DB store now applies before every taken_at bind.
test("toIso converts epoch seconds to an ISO string", () => {
  const iso = toIso(1754006400); // 2025-08-01T00:00:00Z
  assert.equal(typeof iso, "string");
  assert.equal(new Date(iso).getUTCFullYear(), 2025);
});

test("toIso converts a later epoch-seconds value correctly", () => {
  const iso = toIso(1785542400); // 2026-08-01T00:00:00Z
  assert.equal(new Date(iso).getUTCFullYear(), 2026);
});

test("toIso treats large numbers as epoch milliseconds", () => {
  const secondsForm = toIso(1754006400);
  const msForm = toIso(1754006400000);
  assert.equal(new Date(msForm).getUTCFullYear(), 2025);
  assert.equal(secondsForm, msForm);
});

test("toIso passes through an ISO string normalized to milliseconds", () => {
  assert.equal(toIso("2026-08-10T00:00:00Z"), "2026-08-10T00:00:00.000Z");
});

test("toIso returns null for null and unparseable input", () => {
  assert.equal(toIso(null), null);
  assert.equal(toIso("garbage"), null);
});
