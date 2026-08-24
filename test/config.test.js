import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadConfig,
  listBusinesses,
  writeBusiness,
  deleteBusiness,
  readBusiness,
  validateHashtags,
  slugify,
} from "../src/config.js";

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
