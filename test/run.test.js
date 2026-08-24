import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  run,
  acquireLock,
  releaseLock,
  lockPathFor,
  AlreadyRunningError,
} from "../src/run.js";
import { BlockError } from "../src/safety.js";
/** A config with every delay zeroed, so a full run finishes in milliseconds. */
function fastConfig(hashtags, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-test-"));
  return {
    mcpEndpoint: "http://127.0.0.1:1/mcp",
    business: "test-business",
    campaign: "Test Business",
    hashtags,
    safety: {
      maxHashtagsPerRun: 12,
      maxRunMinutes: 60,
      scrollsPerHashtag: 1,
      pageLoadDelayMs: 1,
      scrollPauseMs: [0, 0],
      gapBetweenHashtagsMs: [0, 0],
      initialDwellMs: [0, 0],
      ...overrides,
    },
    dataDir: dir,
    root: dir,
  };
}

const fakeClient = { fake: true };
const deps = (collect) => ({
  connect: async () => fakeClient,
  disconnect: async () => {},
  collect,
});

const TAGS = [
  { platform: "instagram", value: "alpha" },
  { platform: "instagram", value: "beta" },
  { platform: "facebook", value: "gamma" },
];

test("a clean run visits every target and reports complete", async () => {
  const config = fastConfig(TAGS);
  const events = [];
  const result = await run({
    config,
    onEvent: (e) => events.push(e),
    deps: deps(async (_c, h) => [{ platform: h.platform, id: `${h.platform}:${h.value}:1` }]),
  });

  assert.equal(result.status, "complete");
  assert.equal(result.targets.length, 3);

  const types = events.map((e) => e.type);
  assert.equal(types[0], "run_started");
  assert.equal(types.at(-1), "run_finished");
  assert.equal(events.filter((e) => e.type === "hashtag_done").length, 3);
  assert.equal(events.filter((e) => e.type === "waiting").length, 2, "no wait after the last");

  // seq is strictly increasing, which is what makes the client reducer idempotent.
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
});

/**
 * REGRESSION TEST — do not delete.
 *
 * Config files name a hashtag `value`; events name it `hashtag`. When
 * run_started leaked the config shape, every hashtag in the progress UI
 * rendered as a bare "#" and no per-target lookup could match, so a live run
 * showed seven nameless rows stuck on "queued".
 */
test("emitted targets use `hashtag`, never the config's `value`", async () => {
  const config = fastConfig(TAGS);
  const events = [];
  await run({
    config,
    onEvent: (e) => events.push(e),
    deps: deps(async (_c, h) => [{ id: `${h.value}:1` }]),
  });

  const started = events.find((e) => e.type === "run_started");
  assert.equal(started.targets.length, 3);
  for (const target of started.targets) {
    assert.ok(target.hashtag, "every target carries a hashtag name");
    assert.equal(target.value, undefined, "and does not leak the config field name");
    assert.ok(["instagram", "facebook"].includes(target.platform));
  }
  assert.deepEqual(
    [...started.targets].map((t) => t.hashtag).sort(),
    ["alpha", "beta", "gamma"],
  );

  // `waiting.next` feeds the "up next" row and the countdown label.
  for (const waiting of events.filter((e) => e.type === "waiting")) {
    assert.ok(waiting.next.hashtag, "the next target is named too");
    assert.equal(waiting.next.value, undefined);
  }

  // hashtag_done keys must match the target keys the checklist looks up.
  const targetKeys = new Set(started.targets.map((t) => `${t.platform}:${t.hashtag}`));
  for (const done of events.filter((e) => e.type === "hashtag_done")) {
    assert.ok(
      targetKeys.has(`${done.platform}:${done.hashtag}`),
      `hashtag_done for ${done.hashtag} matches a declared target`,
    );
  }
});

test("an empty page is recorded as empty, not as an error", async () => {
  const config = fastConfig([TAGS[0]]);
  const events = [];
  await run({ config, onEvent: (e) => events.push(e), deps: deps(async () => []) });
  const done = events.find((e) => e.type === "hashtag_done");
  assert.equal(done.status, "empty");
  assert.equal(done.postsOnPage, 0);
});

test("a danger signal aborts the whole run and skips the rest", async () => {
  const config = fastConfig(TAGS);
  const events = [];
  const result = await run({
    config,
    onEvent: (e) => events.push(e),
    deps: deps(async () => {
      throw new BlockError("login_wall at https://x/login (during load)", {
        reason: "login_wall",
        url: "https://x/login",
      });
    }),
  });

  assert.equal(result.status, "aborted");
  assert.equal(result.abortReason, "login_wall");

  const danger = events.find((e) => e.type === "danger");
  assert.equal(danger.reason, "login_wall", "reason arrives structurally, not parsed from prose");
  assert.equal(danger.url, "https://x/login");
  // Aborts on the FIRST hashtag, so nothing after it is attempted.
  assert.equal(events.filter((e) => e.type === "hashtag_started").length, 1);
  assert.equal(events.filter((e) => e.type === "waiting").length, 0);
});

test("a non-danger error is recorded and the run continues", async () => {
  const config = fastConfig(TAGS);
  const events = [];
  let calls = 0;
  const result = await run({
    config,
    onEvent: (e) => events.push(e),
    deps: deps(async (_c, h) => {
      calls += 1;
      if (calls === 1) throw new Error("transient DOM hiccup");
      return [{ id: `${h.value}:1` }];
    }),
  });

  assert.equal(result.status, "complete");
  assert.equal(events.filter((e) => e.type === "hashtag_error").length, 1);
  assert.equal(events.filter((e) => e.type === "hashtag_done").length, 2);
});

test("an abort signal stops the run between hashtags", async () => {
  const config = fastConfig(TAGS);
  const controller = new AbortController();
  const events = [];
  const result = await run({
    config,
    signal: controller.signal,
    onEvent: (e) => {
      events.push(e);
      if (e.type === "hashtag_done") controller.abort();
    },
    deps: deps(async (_c, h) => [{ id: `${h.value}:1` }]),
  });

  assert.equal(result.status, "stopped");
  assert.equal(events.filter((e) => e.type === "hashtag_done").length, 1);
});

test("a listener that throws cannot break the run", async () => {
  const config = fastConfig([TAGS[0]]);
  const result = await run({
    config,
    onEvent: () => {
      throw new Error("bad listener");
    },
    deps: deps(async () => [{ id: "x:1" }]),
  });
  assert.equal(result.status, "complete");
});

test("the time budget stops the run and reports how far it got", async () => {
  const config = fastConfig(TAGS);
  config.safety.maxRunMinutes = -1; // already past deadline
  const events = [];
  const result = await run({
    config,
    onEvent: (e) => events.push(e),
    deps: deps(async () => [{ id: "x:1" }]),
  });
  assert.equal(result.status, "budget_stopped");
  assert.equal(events.find((e) => e.type === "budget_reached").completed, 0);
});

test("the lock rejects a second concurrent run and is released afterwards", async () => {
  const config = fastConfig([TAGS[0]]);
  const lockPath = lockPathFor(config.root);
  const held = acquireLock(lockPath, "cli", 60);
  assert.throws(
    () => acquireLock(lockPath, "web", 60),
    (err) => err instanceof AlreadyRunningError && err.code === "ALREADY_RUNNING",
  );
  releaseLock(held);

  // With the lock free, a run completes and cleans up after itself.
  await run({ config, deps: deps(async () => [{ id: "x:1" }]) });
  assert.equal(fs.existsSync(lockPath), false);
});

test("a stale lock from a dead process is taken over", () => {
  const config = fastConfig([TAGS[0]]);
  const lockPath = lockPathFor(config.root);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString(), source: "cli" }),
  );
  const lock = acquireLock(lockPath, "web", 60);
  assert.ok(lock, "dead pid means the lock is stale and can be reclaimed");
  releaseLock(lock);
});

/**
 * REGRESSION TEST — do not delete.
 *
 * The lock guards Chrome, not the data, and every business shares one browser
 * session. A per-business lock let two businesses run at once and fight over
 * the same tab, so the lock is global to the installation.
 */
test("the lock is global, so two businesses cannot run at once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lock-shared-"));
  const lockPath = lockPathFor(root);
  const first = acquireLock(lockPath, "cli", 60);
  assert.throws(
    () => acquireLock(lockPathFor(root), "web", 60),
    (err) => err.code === "ALREADY_RUNNING",
    "a second business is refused even though its data lives elsewhere",
  );
  releaseLock(first);
  releaseLock(acquireLock(lockPathFor(root), "web", 60));
});

test("an injected store receives every result and no files are written", async () => {
  const config = fastConfig(TAGS);
  const written = [];
  const seen = new Map();

  // Stands in for the database-backed store the web app injects.
  const store = {
    kind: "test",
    async record(h, posts) {
      const key = `${h.platform}:${h.value}`;
      const known = seen.get(key) ?? new Set();
      let newCount = 0;
      for (const p of posts) {
        if (!known.has(p.id)) {
          known.add(p.id);
          newCount += 1;
        }
      }
      seen.set(key, known);
      return { newCount, cumulative: known.size };
    },
    async writeRow(h, runAt, row) {
      written.push({ hashtag: h.value, runAt, ...row });
    },
    async seenCount(h) {
      return (seen.get(`${h.platform}:${h.value}`) ?? new Set()).size;
    },
    async finish() {},
  };

  const result = await run({
    config,
    store,
    deps: deps(async (_c, h) => [{ id: `${h.value}:1` }, { id: `${h.value}:2` }]),
  });

  assert.equal(result.status, "complete");
  assert.equal(result.store, "test", "the run reports which store it used");
  assert.equal(written.length, 3, "one row per hashtag");
  for (const row of written) {
    assert.equal(row.newCount, 2);
    assert.equal(row.cumulative, 2);
    assert.equal(row.postsOnPage, 2, "posts-on-page reaches the store");
    assert.equal(row.status, "ok");
    assert.ok(row.visitSeq >= 1);
  }

  // The whole point: with a store supplied, the run leaves no result files.
  assert.equal(fs.existsSync(path.join(config.dataDir, "tally.csv")), false);
  assert.equal(fs.existsSync(path.join(config.dataDir, "seen.json")), false);
  assert.equal(fs.existsSync(path.join(config.dataDir, "posts")), false);
});

test("a caller-supplied run id is used for the store and the events", async () => {
  const config = fastConfig([TAGS[0]]);
  const events = [];
  const rows = [];
  const store = {
    kind: "test",
    async record() {
      return { newCount: 1, cumulative: 1 };
    },
    async writeRow(h, runAt) {
      rows.push(runAt);
    },
    async seenCount() {
      return 0;
    },
    async finish() {},
  };

  const runId = "2030-01-02T03:04:05.678Z";
  const result = await run({
    config,
    store,
    runId,
    onEvent: (e) => events.push(e),
    deps: deps(async () => [{ id: "x:1" }]),
  });

  assert.equal(result.runId, runId);
  assert.equal(events.find((e) => e.type === "run_started").runId, runId);
  assert.deepEqual(rows, [runId], "the store is told the same id");
});
