import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect, disconnect, evalJs, sleep } from "./mcp.service.js";
import { IG_EXTRACT, FB_EXTRACT } from "./extract.service.js";
import { createFileStore } from "../stores/fileStore.js";
import {
  rand,
  jitter,
  shuffle,
  navigate,
  humanScroll,
  assertSafe,
  BlockError,
} from "./safety.service.js";
import { hashtagUrl } from "../config/index.js";

/**
 * The run loop, as a library.
 *
 * Emits typed events instead of printing, and writes through an injected store,
 * so the same loop serves the CLI (files) and the web app (Postgres) without
 * knowing which. Nothing here touches stdout.
 */

/* ---------------- lockfile ----------------
   Guards the BROWSER, not the data. Every business shares one Chrome session
   and one mcp-chrome bridge, so the lock is global rather than per business —
   two businesses running at once would fight over the same tab. It also spans
   both entry points, so a terminal run and a web run cannot overlap, and it
   needs no database. */

export class AlreadyRunningError extends Error {
  constructor(message, holder) {
    super(message);
    this.name = "AlreadyRunningError";
    this.code = "ALREADY_RUNNING";
    this.holder = holder;
  }
}

/** One lock for the whole installation, since Chrome is the shared resource. */
export function lockPathFor(root) {
  return path.join(root, "data", "run.lock");
}

export function acquireLock(lockPath, source, maxRunMinutes) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    source,
  });

  try {
    fs.writeFileSync(lockPath, payload, { flag: "wx" });
    return lockPath;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }

  // Someone holds it. A dead PID means a crashed run we can safely take over —
  // detected immediately, rather than by waiting out a timeout.
  let held = null;
  try {
    held = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    /* an unreadable lock is treated as stale */
  }

  let alive = false;
  if (held?.pid) {
    try {
      process.kill(held.pid, 0); // signal 0 = liveness probe, works on Windows
      // Same-pid counts as alive: two runs inside one process (the web server
      // starting a second run) is exactly what this lock exists to prevent.
      alive = true;
    } catch {
      alive = false;
    }
  }

  const ageMinutes = (() => {
    try {
      return (Date.now() - fs.statSync(lockPath).mtimeMs) / 60_000;
    } catch {
      return Infinity;
    }
  })();

  if (alive && ageMinutes < maxRunMinutes + 10) {
    throw new AlreadyRunningError(
      `a run is already in progress (pid ${held.pid}, started ${held.startedAt}, via ${held.source})`,
      held,
    );
  }

  fs.rmSync(lockPath, { force: true });
  fs.writeFileSync(lockPath, payload, { flag: "wx" });
  return lockPath;
}

export function releaseLock(lockPath) {
  if (!lockPath) return;
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    /* nothing useful to do */
  }
}

/* ---------------- collection ---------------- */

export async function collect(client, h, safety) {
  await navigate(client, hashtagUrl(h));
  await sleep(safety.pageLoadDelayMs);
  await assertSafe(client, `${h.platform}#${h.value} load`);
  await jitter(safety.initialDwellMs);
  await humanScroll(client, {
    steps: safety.scrollsPerHashtag,
    scrollPauseMs: safety.scrollPauseMs,
  });
  await assertSafe(client, `${h.platform}#${h.value} after-scroll`);

  const res = await evalJs(client, h.platform === "instagram" ? IG_EXTRACT : FB_EXTRACT);
  if (res.loggedOut) {
    throw new BlockError(`not logged in to ${h.platform}`, {
      reason: "login_wall",
      url: hashtagUrl(h),
    });
  }
  return res.posts;
}

/* ---------------- the run ---------------- */

/**
 * @param {object} opts
 * @param {object} opts.config       from loadConfig()
 * @param {object} [opts.store]      storage backend; defaults to files in config.dataDir
 * @param {(e:object)=>void} [opts.onEvent]
 * @param {AbortSignal} [opts.signal] cooperative stop between hashtags
 * @param {'web'|'cli'} [opts.source]
 * @param {object} [opts.deps]       test seams: {connect, disconnect, collect}
 */
export async function run({
  config,
  store,
  onEvent = () => {},
  signal,
  source = "cli",
  runId,
  deps = {},
} = {}) {
  const cx = deps.connect ?? connect;
  const dx = deps.disconnect ?? disconnect;
  const co = deps.collect ?? collect;

  const S = config.safety;
  // The caller may supply the id so its store, its ledger and these events all
  // reference the same run; otherwise mint one.
  const runAt = runId ?? new Date().toISOString();
  let seq = 0;

  // A listener that throws (or a failing store) must never abort a scrape that
  // is holding the only Chrome session.
  const emit = (type, data = {}) => {
    try {
      onEvent({ type, seq: ++seq, at: new Date().toISOString(), ...data });
    } catch {
      /* deliberately swallowed */
    }
  };

  const targets = shuffle(config.hashtags).slice(0, S.maxHashtagsPerRun);
  const deadline = Date.now() + S.maxRunMinutes * 60_000;

  // Events use `hashtag` throughout, while config files use `value`. Translate
  // once, here, so every consumer sees one shape — a mismatch between the two
  // silently renders empty hashtag names and breaks per-target lookups.
  const asTarget = (h) => ({ platform: h.platform, hashtag: h.value });

  const lock = acquireLock(lockPathFor(config.root), source, S.maxRunMinutes);
  const results = store ?? createFileStore(config.dataDir);

  let status = "complete";
  let abortReason = null;
  let client = null;

  emit("run_started", {
    runId: runAt,
    campaign: config.campaign,
    business: config.business,
    store: results.kind ?? "unknown",
    targets: targets.map(asTarget),
    budgetMinutes: S.maxRunMinutes,
  });

  try {
    client = await cx(config.mcpEndpoint, {
      onEvent: (e) => emit("connect_retry", e),
    });

    for (let i = 0; i < targets.length; i++) {
      const h = targets[i];

      if (signal?.aborted) {
        status = "stopped";
        break;
      }
      if (Date.now() > deadline) {
        status = "budget_stopped";
        emit("budget_reached", { completed: i });
        break;
      }

      emit("hashtag_started", { platform: h.platform, hashtag: h.value, visitSeq: i + 1 });

      try {
        const posts = await co(client, h, S);
        const { newCount, cumulative } = await results.record(h, posts, runAt);
        const rowStatus = posts.length ? "ok" : "empty";
        await results.writeRow(h, runAt, {
          newCount,
          cumulative,
          status: rowStatus,
          postsOnPage: posts.length,
          visitSeq: i + 1,
        });
        emit("hashtag_done", {
          platform: h.platform,
          hashtag: h.value,
          visitSeq: i + 1,
          postsOnPage: posts.length,
          newCount,
          cumulative,
          status: rowStatus,
        });
      } catch (err) {
        const cumulative = await results.seenCount(h).catch(() => 0);
        if (err instanceof BlockError) {
          await results
            .writeRow(h, runAt, {
              newCount: 0,
              cumulative,
              status: "aborted",
              postsOnPage: null,
              visitSeq: i + 1,
              message: err.reason ?? err.message,
            })
            .catch(() => {});
          status = "aborted";
          abortReason = err.reason ?? "unknown";
          emit("danger", {
            platform: h.platform,
            hashtag: h.value,
            reason: err.reason ?? "unknown",
            url: err.url ?? null,
            message: err.message,
          });
          break; // never retry past a danger signal
        }
        await results
          .writeRow(h, runAt, {
            newCount: 0,
            cumulative,
            status: "error",
            postsOnPage: null,
            visitSeq: i + 1,
            message: err.message,
          })
          .catch(() => {});
        emit("hashtag_error", {
          platform: h.platform,
          hashtag: h.value,
          visitSeq: i + 1,
          message: err.message,
        });
      }

      if (i < targets.length - 1) {
        const gapMs = rand(S.gapBetweenHashtagsMs[0], S.gapBetweenHashtagsMs[1]);
        emit("waiting", {
          seconds: Math.round(gapMs / 1000),
          next: asTarget(targets[i + 1]),
        });
        // Abortable, so a Stop button doesn't wait out a 7-minute gap.
        await delay(gapMs, undefined, { signal }).catch(() => {});
      }
    }
  } finally {
    // Must run: skipping it leaves a ghost MCP session that blocks the next run.
    await dx(client);
    await Promise.resolve(results.finish?.()).catch(() => {});
    releaseLock(lock);
  }

  emit("run_finished", { status, abortReason });
  return {
    runId: runAt,
    status,
    abortReason,
    targets: targets.map(asTarget),
    store: results.kind ?? "unknown",
  };
}

export async function check({ config, deps = {} }) {
  const cx = deps.connect ?? connect;
  const dx = deps.disconnect ?? disconnect;
  const client = await cx(config.mcpEndpoint);
  try {
    const { tools } = await client.listTools();
    return { toolCount: tools.length, tools: tools.map((t) => t.name) };
  } finally {
    await dx(client);
  }
}
