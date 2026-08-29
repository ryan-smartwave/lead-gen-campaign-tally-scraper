// test/enrich.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectForEnrichment, enrichPost } from "../src/services/enrich.service.js";
import { BlockError } from "../src/services/safety.service.js";

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

test("selectForEnrichment respects cap boundary when cap <= 0", () => {
  const recs = [
    { id: "ig:p/1", platform: "instagram", takenAt: null, caption: "c", username: "u" },
    { id: "ig:p/2", platform: "instagram", takenAt: null, caption: "c", username: "u" },
  ];
  assert.deepEqual(selectForEnrichment(recs, 0), []);
  assert.deepEqual(selectForEnrichment(recs, -1), []);
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
      // compact in-page records (IG_POST_EXTRACT walks the page itself; raw
      // blobs are truncated by the bridge and can never be shipped)
      records: [
        { code: "ABC", like_count: 7, taken_at: 123, user: { username: "acme" }, caption: { text: "hello" } },
      ],
      ogImage: "b64:" + Buffer.from("https://scontent.cdninstagram.com/v/x.jpg?oh=1&oe=2").toString("base64"),
    }),
  };
  const out = await enrichPost({ fake: true }, record, deps);
  assert.equal(out.username, "acme");
  assert.equal(out.caption, "hello");
  assert.equal(out.takenAt, 123);
  assert.equal(out.imageUrl, "https://scontent.cdninstagram.com/v/x.jpg?oh=1&oe=2");
  assert.ok(out.enrichedAt);
});

test("enrichPost rejects when evalJs returns loggedOut: true", async () => {
  const record = { id: "ig:p/ABC", platform: "instagram", takenAt: null, caption: null, username: null, imageUrl: null };
  const deps = {
    navigate: async () => {},
    assertSafe: async () => {},
    sleep: async () => {},
    pageLoadDelayMs: 0, dwellMs: 0,
    journal: { log: () => {} },
    evalJs: async () => ({ loggedOut: true }),
  };
  await assert.rejects(
    enrichPost({ fake: true }, record, deps),
    (e) => e.name === "BlockError"
  );
});

test("enrichPost marks fields it filled as enrichment-sourced", async () => {
  const record = {
    id: "ig:p/EN1", platform: "instagram", url: "https://x",
    caption: null, username: null, likeCount: null,
    fieldSources: { caption: "missed:capture,prop", username: "missed:capture,prop" },
  };
  const deps = {
    navigate: async () => {},
    evalJs: async () => ({
      loggedOut: false,
      records: [{ code: "EN1", caption: { text: "found it" }, user: { username: "u1" } }],
    }),
    assertSafe: async () => {},
    sleep: async () => {},
    pageLoadDelayMs: 1,
    dwellMs: 1,
  };
  const out = await enrichPost({}, record, deps);
  assert.equal(out.caption, "found it");
  assert.equal(out.fieldSources.caption, "enrichment");
  assert.equal(out.fieldSources.username, "enrichment");
});
