import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadConfig,
  loadGlobal,
  listBusinesses,
  writeBusiness,
  deleteBusiness,
  readBusiness,
  validateHashtags,
  slugify,
  validateCampaignDates,
} from "../src/config/index.js";

/** A throwaway scraper root with a valid global config.json. */
function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-test-"));
  fs.writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({
      mcpEndpoint: "http://127.0.0.1:12306/mcp",
      safety: {
        maxHashtagsPerRun: 12,
        maxRunMinutes: 60,
        scrollsPerHashtag: 5,
        pageLoadDelayMs: 6000,
        scrollPauseMs: [3000, 9000],
        gapBetweenHashtagsMs: [180000, 420000],
        initialDwellMs: [2000, 5000],
      },
    }),
  );
  return root;
}

test("businesses round-trip through disk", () => {
  const root = tmpRoot();
  writeBusiness(
    { slug: "acme-events", name: "Acme Events", hashtags: [{ platform: "instagram", value: "acme" }] },
    root,
  );
  writeBusiness({ slug: "bolt-cafe", name: "Bolt Cafe", hashtags: [] }, root);

  const all = listBusinesses(root);
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((b) => b.slug),
    ["acme-events", "bolt-cafe"],
    "sorted by name",
  );
  assert.equal(readBusiness("acme-events", root).name, "Acme Events");

  deleteBusiness("bolt-cafe", root);
  assert.equal(listBusinesses(root).length, 1);
});

test("each business gets its own data directory", () => {
  const root = tmpRoot();
  writeBusiness(
    { slug: "one", name: "One", hashtags: [{ platform: "instagram", value: "a" }] },
    root,
  );
  writeBusiness(
    { slug: "two", name: "Two", hashtags: [{ platform: "facebook", value: "b" }] },
    root,
  );

  const first = loadConfig({ business: "one", root });
  const second = loadConfig({ business: "two", root });

  assert.notEqual(first.dataDir, second.dataDir);
  assert.ok(first.dataDir.endsWith(path.join("data", "one")));
  // Separate dirs mean separate seen.json and separate run.lock, so two
  // businesses can never corrupt each other's dedup memory.
  assert.equal(first.safety.maxRunMinutes, 60, "safety comes from the shared global config");
  assert.equal(second.campaign, "Two");
});

test("loadConfig rejects an unknown business and an empty one", () => {
  const root = tmpRoot();
  writeBusiness({ slug: "empty", name: "Empty", hashtags: [] }, root);
  assert.throws(() => loadConfig({ business: "nope", root }), /unknown business/);
  assert.throws(() => loadConfig({ business: "empty", root }), /no hashtags/);
});

test("loadConfig fails clearly when no businesses exist", () => {
  assert.throws(() => loadConfig({ root: tmpRoot() }), /no businesses defined/);
});

test("hashtag validation blocks anything that would corrupt the csv", () => {
  assert.deepEqual(validateHashtags([{ platform: "instagram", value: "ok_tag.1" }]), []);
  assert.ok(validateHashtags([{ platform: "instagram", value: "with,comma" }]).length);
  assert.ok(validateHashtags([{ platform: "instagram", value: "#hash" }]).length);
  assert.ok(validateHashtags([{ platform: "twitter", value: "x" }]).length);
  assert.ok(
    validateHashtags([
      { platform: "instagram", value: "dupe" },
      { platform: "instagram", value: "dupe" },
    ]).length,
    "duplicates are rejected",
  );
});

test("writeBusiness rejects a bad slug and bad hashtags", () => {
  const root = tmpRoot();
  assert.throws(() => writeBusiness({ slug: "Bad Slug", name: "x" }, root), /invalid slug/);
  assert.throws(
    () =>
      writeBusiness(
        { slug: "ok", name: "Ok", hashtags: [{ platform: "instagram", value: "a,b" }] },
        root,
      ),
    /invalid hashtags/,
  );
});

test("slugify produces usable slugs", () => {
  assert.equal(slugify("Acme Events & Co."), "acme-events-co");
  assert.equal(slugify("  Bolt  Cafe  "), "bolt-cafe");
});

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

test("loadGlobal exposes the new safety keys with defaults applied", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    mcpEndpoint: "http://127.0.0.1:12306/mcp",
    safety: {
      maxHashtagsPerRun: 12, maxRunMinutes: 60, scrollsPerHashtag: 5, pageLoadDelayMs: 6000,
      scrollPauseMs: [1, 2], gapBetweenHashtagsMs: [1, 2], initialDwellMs: [1, 2],
    },
  }));
  const g = loadGlobal(root);
  assert.equal(typeof g.safety.maxPostVisitsPerRun, "number");
  assert.equal(typeof g.safety.pipelineTabs, "boolean");
  assert.equal(typeof g.safety.journalRetentionDays, "number");
});

/** Minimal valid safety block for deep-scroll tests. */
const BASE_SAFETY = {
  maxHashtagsPerRun: 12, maxRunMinutes: 60, scrollsPerHashtag: 5, pageLoadDelayMs: 6000,
  scrollPauseMs: [1, 2], gapBetweenHashtagsMs: [1, 2], initialDwellMs: [1, 2],
};

function rootWithSafety(extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    mcpEndpoint: "http://127.0.0.1:12306/mcp",
    safety: { ...BASE_SAFETY, ...extra },
  }));
  return root;
}

test("deep-scroll keys default sanely when absent", () => {
  const g = loadGlobal(rootWithSafety({}));
  assert.equal(g.safety.scrollMinutesPerHashtag, null, "absent = legacy step mode");
  assert.equal(g.safety.dryStopAfterScrolls, 10);
  assert.equal(g.safety.maxPostsPerHashtag, 3000);
  assert.deepEqual(g.safety.restEveryMs, [150_000, 300_000]);
  assert.deepEqual(g.safety.restPauseMs, [15_000, 45_000]);
});

test("scrollMinutesPerHashtag round-trips as a pair", () => {
  const g = loadGlobal(rootWithSafety({ scrollMinutesPerHashtag: [20, 28] }));
  assert.deepEqual(g.safety.scrollMinutesPerHashtag, [20, 28]);
});

test("scrollMinutesPerHashtag rejects bad shapes and the >45min ceiling", () => {
  assert.throws(() => loadGlobal(rootWithSafety({ scrollMinutesPerHashtag: 20 })), /min, max/);
  assert.throws(() => loadGlobal(rootWithSafety({ scrollMinutesPerHashtag: [28, 20] })), /min, max/);
  assert.throws(() => loadGlobal(rootWithSafety({ scrollMinutesPerHashtag: [10, 90] })), /capped at 45/);
});

test("campaign dates round-trip and are preserved on undefined", () => {
  const root = tmpRoot();
  // Write a business with campaign dates
  writeBusiness(
    {
      slug: "dated-biz",
      name: "Dated Business",
      hashtags: [],
      campaignStart: "2026-08-01",
      campaignEnd: "2026-08-31",
    },
    root,
  );
  // Verify dates round-trip through readBusiness
  const read1 = readBusiness("dated-biz", root);
  assert.equal(read1.campaignStart, "2026-08-01");
  assert.equal(read1.campaignEnd, "2026-08-31");

  // Update without dates: undefined should preserve existing values
  writeBusiness(
    {
      slug: "dated-biz",
      name: "Updated Name",
      hashtags: [],
      campaignStart: undefined,
      campaignEnd: undefined,
    },
    root,
  );
  const read2 = readBusiness("dated-biz", root);
  assert.equal(read2.campaignStart, "2026-08-01", "omitted date preserved existing campaignStart");
  assert.equal(read2.campaignEnd, "2026-08-31", "omitted date preserved existing campaignEnd");
  assert.equal(read2.name, "Updated Name", "name was updated");
});

/* ---------------- hashtagUrl campaign-date filter ---------------- */

// Decode the FB `filters` param back to the creation_time args object.
function decodeFilters(url) {
  const m = new URL(url).searchParams.get("filters");
  if (!m) return null;
  const outer = JSON.parse(Buffer.from(m, "base64").toString("utf8"));
  const wrapper = JSON.parse(outer["rp_creation_time:0"]);
  return { name: wrapper.name, args: JSON.parse(wrapper.args) };
}

test("hashtagUrl adds a day-granularity FB date filter for a full campaign window", async () => {
  const { hashtagUrl } = await import("../src/config/index.js");
  const window = { start: new Date("2026-06-01"), end: new Date("2026-08-27") };
  const url = hashtagUrl({ platform: "facebook", value: "weddingsph" }, window);
  assert.ok(url.startsWith("https://www.facebook.com/search/posts?q=%23weddingsph"));
  const f = decodeFilters(url);
  assert.equal(f.name, "creation_time");
  assert.deepEqual(f.args, {
    start_year: "2026",
    start_month: "2026-6",
    start_day: "2026-6-1",
    end_year: "2026",
    end_month: "2026-8",
    end_day: "2026-8-27",
  });
});

test("hashtagUrl leaves FB unfiltered without a complete window", async () => {
  const { hashtagUrl } = await import("../src/config/index.js");
  const plain = "https://www.facebook.com/search/posts?q=%23weddingsph";
  const h = { platform: "facebook", value: "weddingsph" };
  assert.equal(hashtagUrl(h), plain);
  assert.equal(hashtagUrl(h, { start: null, end: null }), plain);
  assert.equal(hashtagUrl(h, { start: new Date("2026-06-01"), end: null }), plain);
});

test("hashtagUrl ignores the window on Instagram", async () => {
  const { hashtagUrl } = await import("../src/config/index.js");
  const window = { start: new Date("2026-06-01"), end: new Date("2026-08-27") };
  assert.equal(
    hashtagUrl({ platform: "instagram", value: "weddingsph" }, window),
    "https://www.instagram.com/explore/tags/weddingsph/",
  );
});

test("loadGlobal defaults the enrichment and cross-platform gap pairs", () => {
  const root = tmpRoot();
  const cfg = loadGlobal(root);
  assert.deepEqual(cfg.safety.postVisitGapMs, [45000, 120000]);
  assert.deepEqual(cfg.safety.crossPlatformGapMs, [60000, 150000]);
});

test("loadGlobal rejects malformed postVisitGapMs", () => {
  const root = tmpRoot();
  const file = path.join(root, "config.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.safety.postVisitGapMs = [5000];
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => loadGlobal(root), /postVisitGapMs/);
});
