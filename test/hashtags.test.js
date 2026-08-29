import { test } from "node:test";
import assert from "node:assert/strict";
import { extractOtherHashtags } from "../src/utils/hashtags.js";

test("extracts hashtags from caption text, lowercased and deduped", () => {
  assert.deepEqual(
    extractOtherHashtags("Big day! #WeddingsPH #Tagaytay #wedding #TAGAYTAY", "weddingsph"),
    ["tagaytay", "wedding"],
  );
});

test("excludes the searched hashtag case-insensitively", () => {
  assert.deepEqual(extractOtherHashtags("#WEDDINGSPH only", "weddingsph"), []);
});

test("handles unicode letters and underscores", () => {
  assert.deepEqual(
    extractOtherHashtags("#kasal_2026 #boda_española #結婚式", "weddingsph"),
    ["kasal_2026", "boda_española", "結婚式"],
  );
});

test("returns [] for empty or hashtag-free text", () => {
  assert.deepEqual(extractOtherHashtags(null, "x"), []);
  assert.deepEqual(extractOtherHashtags("", "x"), []);
  assert.deepEqual(extractOtherHashtags("no tags here", "x"), []);
});

test("ignores lone # and # followed by punctuation", () => {
  assert.deepEqual(extractOtherHashtags("# not a tag, #!bang, ok #real", "x"), ["real"]);
});
