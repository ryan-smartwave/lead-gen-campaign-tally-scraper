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
