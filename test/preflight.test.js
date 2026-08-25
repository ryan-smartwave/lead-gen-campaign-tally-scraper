import { test } from "node:test";
import assert from "node:assert/strict";
import { coverageCheck } from "../src/utils/coverage.js";

test("coverage warns when a business tracks more hashtags than one run visits", () => {
  const check = coverageCheck(15, 12);
  assert.equal(check.state, "warn");
  assert.match(check.detail, /15/);
  assert.match(check.detail, /12/);
  assert.match(check.detail, /least recently/i, "explains the rotation, not just the cap");
});

test("coverage is ok when every hashtag fits in one run", () => {
  assert.equal(coverageCheck(12, 12).state, "ok");
  assert.equal(coverageCheck(0, 12).state, "ok");
});
