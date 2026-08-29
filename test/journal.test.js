import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJournal, sanitizeRunId } from "../src/services/journal.service.js";

test("sanitizeRunId strips characters illegal on Windows", () => {
  assert.equal(sanitizeRunId("2026-08-25T09:30:00.000Z"), "2026-08-25T09-30-00.000Z");
});

test("log appends ordered JSONL and tail reads the last N", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jrnl-"));
  const j = createJournal({ root, runId: "2026-08-25T00:00:00.000Z", campaign: "b", retentionDays: 30 });
  j.log("navigate", { platform: "instagram", hashtag: "alpha" });
  j.log("scroll", { detail: { step: 1 } });
  j.log("gap", { detail: { ms: 1000 } });
  const t = j.tail(2);
  assert.equal(t.length, 2);
  assert.equal(t[0].action, "scroll");
  assert.equal(t[1].action, "gap");
  assert.equal(t[1].seq, 4);
});

test("retention prunes old journal files but keeps recent ones", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jrnl-"));
  const dir = path.join(root, "data", "journal");
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, "old.jsonl");
  fs.writeFileSync(old, "{}\n");
  const past = Date.now() - 40 * 86400_000;
  fs.utimesSync(old, past / 1000, past / 1000);
  createJournal({ root, runId: "2026-08-25T00:00:00.000Z", campaign: "b", retentionDays: 30 });
  assert.equal(fs.existsSync(old), false);
});

test("a failing filesystem never throws from log", () => {
  const j = createJournal({ root: "/nonexistent-\0-root", runId: "x", campaign: "b", retentionDays: 30 });
  assert.doesNotThrow(() => j.log("navigate"));
  assert.deepEqual(j.tail(5), []);
});
