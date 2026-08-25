import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect, disconnect, evalJs, sleep, detectCaps, screenshot as mcpScreenshot } from "./mcp.service.js";
import { IG_EXTRACT, FB_EXTRACT } from "./extract.service.js";
import { IG_CAPTURE_INSTALL, IG_CAPTURE_HARVEST, normalizeCaptured, mergeRecords } from "./capture.service.js";
import { selectForEnrichment, enrichPost } from "./enrich.service.js";
import { createJournal } from "./journal.service.js";
import { captureIncident } from "./incident.service.js";
import { planNext } from "./pipeline.service.js";
import { parseWindow } from "../utils/freshness.js";
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

export async function collect(client, h, safety, ctx = {}) {
  const { journal, preloaded } = ctx;
  if (!preloaded) {
    await navigate(client, hashtagUrl(h));
    journal?.log?.("navigate", { platform: h.platform, hashtag: h.value });
  } else {
    // The page is already loaded in the one active tab from the preceding
    // gap's preload — nothing to navigate, just note the handoff.
    journal?.log?.("tab_switch", { platform: h.platform, hashtag: h.value });
  }
  await sleep(safety.pageLoadDelayMs);
  await assertSafe(client, `${h.platform}#${h.value} load`);

  if (h.platform === "instagram") {
    // Idempotent (guarded by `if(!window.__swCapture)`), so calling it again
    // for an already-preloaded page is harmless.
    await evalJs(client, IG_CAPTURE_INSTALL).catch(() => {});
  }
  await jitter(safety.initialDwellMs);
  journal?.log?.("dwell", { platform: h.platform, hashtag: h.value });
  await humanScroll(
    client,
    { steps: safety.scrollsPerHashtag, scrollPauseMs: safety.scrollPauseMs },
    journal,
  );
  await assertSafe(client, `${h.platform}#${h.value} after-scroll`);

  const res = await evalJs(client, h.platform === "instagram" ? IG_EXTRACT : FB_EXTRACT);
  if (res.loggedOut) {
    throw new BlockError(`not logged in to ${h.platform}`, {
      reason: "login_wall",
      url: hashtagUrl(h),
    });
  }

  if (h.platform === "instagram") {
    let captured = [];
    try {
      const raw = await evalJs(client, IG_CAPTURE_HARVEST);
      captured = normalizeCaptured(raw);
    } catch {
      /* degrade to DOM-only */
    }
    journal?.log?.("capture_harvest", {
      platform: h.platform,
      hashtag: h.value,
      detail: { records: captured.length },
    });
    return mergeRecords(res.posts, captured);
  }
  journal?.log?.("extract", {
    platform: h.platform,
    hashtag: h.value,
    detail: { posts: res.posts.length },
  });
  return res.posts;
}

/* ---------------- target selection ---------------- */

/**
 * Which hashtags does this run visit?
 *
 * Under the cap: all of them, shuffled (ANTIBAN.md §6). Over the cap, a pure
 * shuffle would let an unlucky hashtag starve for days, so the least recently
 * visited are chosen first — asked of the store, because visit history must
 * come from the same place the results go, like dedup does. Ties (including
 * never-visited) break randomly, and the chosen set is shuffled again so the
 * visit order never telegraphs the rotation. A store without history, or one
 * that cannot answer, falls back to the shuffled slice: rotation is a
 * refinement, never something that can block a run.
 */
export async function selectTargets(hashtags, cap, store) {
  if (hashtags.length <= cap) return shuffle(hashtags);

  let visits = null;
  try {
    visits = store?.lastVisits ? await store.lastVisits(hashtags) : null;
  } catch {
    visits = null;
  }
  if (!visits) return shuffle(hashtags).slice(0, cap);

  // ISO timestamps compare lexically; "" sorts never-visited first. The sort is
  // stable, so pre-shuffling randomizes the order among equal visit times.
  const last = (h) => visits[`${h.platform}:${h.value}`] ?? "";
  const chosen = shuffle(hashtags)
    .sort((a, b) => (last(a) < last(b) ? -1 : last(a) > last(b) ? 1 : 0))
    .slice(0, cap);
  return shuffle(chosen);
}

/* ---------------- the run ---------------- */

/**
 * @param {object} opts
 * @param {object} opts.config       from loadConfig()
 * @param {object} [opts.store]      storage backend; defaults to files in config.dataDir
 * @param {(e:object)=>void} [opts.onEvent]
 * @param {AbortSignal} [opts.signal] cooperative stop between hashtags
 * @param {'web'|'cli'} [opts.source]
 * @param {boolean} [opts.startNow]  skip the start jitter (supervised CLI runs only)
 * @param {object} [opts.deps]       test seams: {connect, disconnect, collect}
 */
export async function run({
  config,
  store,
  onEvent = () => {},
  signal,
  source = "cli",
  runId,
  startNow = false,
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

  // The campaign window every freshness count is measured against, and the
  // per-run forensic trail. Both are best-effort: a journal write must never
  // break a scrape, so every call below goes through `journal?.log?.(...)`.
  const window = parseWindow({ campaignStart: config.campaignStart, campaignEnd: config.campaignEnd });
  const journal = createJournal({
    root: config.root,
    runId: runAt,
    business: config.business,
    retentionDays: S.journalRetentionDays,
  });
  let caps = { tabs: false, screenshot: false };
  let downgraded = false;
  // Instagram records still missing fields (caption/username/takenAt), queued
  // during the main loop and visited individually in the enrichment phase.
  const enrichQueue = [];

  // A listener that throws (or a failing store) must never abort a scrape that
  // is holding the only Chrome session.
  const emit = (type, data = {}) => {
    try {
      onEvent({ type, seq: ++seq, at: new Date().toISOString(), ...data });
    } catch {
      /* deliberately swallowed */
    }
  };

  // Events use `hashtag` throughout, while config files use `value`. Translate
  // once, here, so every consumer sees one shape — a mismatch between the two
  // silently renders empty hashtag names and breaks per-target lookups.
  const asTarget = (h) => ({ platform: h.platform, hashtag: h.value });

  const lock = acquireLock(lockPathFor(config.root), source, S.maxRunMinutes);
  const results = store ?? createFileStore(config.dataDir);

  // Selection needs the store: over the cap, it asks for visit history.
  const targets = await selectTargets(config.hashtags, S.maxHashtagsPerRun, results);

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
    // ANTIBAN.md §6: firing at the same clock minute daily is itself a fixed
    // rhythm, so every run holds back a random beat before touching anything.
    // Announced as a `waiting` event so watchers see a countdown, not a hang.
    if (!startNow && S.startJitterMs?.[1] > 0) {
      const waitMs = rand(S.startJitterMs[0], S.startJitterMs[1]);
      emit("waiting", {
        seconds: Math.round(waitMs / 1000),
        reason: "start_jitter",
        next: asTarget(targets[0]),
      });
      await delay(waitMs, undefined, { signal }).catch(() => {});
    }

    client = await cx(config.mcpEndpoint, {
      onEvent: (e) => emit("connect_retry", e),
    });

    caps = await detectCaps(client).catch(() => ({ tabs: false, screenshot: false }));
    if (!S.pipelineTabs) caps.tabs = false;

    // Started after the jitter: the budget measures scraping, not the wait.
    const deadline = Date.now() + S.maxRunMinutes * 60_000;

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
        const posts = await co(client, h, S, { journal, caps, preloaded: h.__preloaded });
        const { newCount, freshCount, cumulative } = await results.record(h, posts, runAt, window);
        const rowStatus = posts.length ? "ok" : "empty";
        await results.writeRow(h, runAt, {
          newCount,
          freshCount,
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
          freshCount,
          cumulative,
          status: rowStatus,
        });

        // Fill the enrichment queue up to the per-run visit budget as we go.
        const room = Math.max(0, (S.maxPostVisitsPerRun ?? 0) - enrichQueue.length);
        for (const p of selectForEnrichment(posts, room)) enrichQueue.push({ ...p, hashtag: h });
      } catch (err) {
        const cumulative = await results.seenCount(h).catch(() => 0);
        if (err instanceof BlockError) {
          await results
            .writeRow(h, runAt, {
              newCount: 0,
              freshCount: 0,
              cumulative,
              status: "aborted",
              postsOnPage: null,
              visitSeq: i + 1,
              message: err.reason ?? err.message,
            })
            .catch(() => {});
          status = "aborted";
          abortReason = err.reason ?? "unknown";
          let incidentDir = null;
          try {
            ({ incidentDir } = await captureIncident({
              root: config.root,
              runId: runAt,
              business: config.business,
              error: err,
              journal,
              client,
              caps,
              deps: { evalJs, screenshot: mcpScreenshot },
            }));
          } catch {
            /* swallow: an incident bundle must never break the abort path */
          }
          emit("danger", {
            platform: h.platform,
            hashtag: h.value,
            reason: err.reason ?? "unknown",
            url: err.url ?? null,
            message: err.message,
            incidentDir,
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
        // Single-tab in-place pipelining: during the idle gap, navigate the
        // ONE active tab to the next hashtag's URL (never a background tab —
        // ANTIBAN.md requires exactly one active tab at all times) and, for
        // an Instagram next-target, arm capture immediately so it is
        // installed before the feed's API calls fire during the gap.
        const plan = planNext({ index: i, targets, caps, downgraded });
        if (plan.preload) {
          try {
            await navigate(client, plan.url);
            if (targets[i + 1].platform === "instagram") {
              await evalJs(client, IG_CAPTURE_INSTALL);
            }
            targets[i + 1].__preloaded = true;
            journal?.log?.("preload", { detail: { url: plan.url } });
          } catch {
            // Pipelining is a refinement, never something that can abort a
            // run: downgrade to plain sequential visits for the rest of it.
            downgraded = true;
            journal?.log?.("downgrade", { detail: { reason: "preload_failed" } });
          }
        }
        const gapMs = rand(S.gapBetweenHashtagsMs[0], S.gapBetweenHashtagsMs[1]);
        journal?.log?.("gap", { detail: { ms: gapMs } });
        emit("waiting", {
          seconds: Math.round(gapMs / 1000),
          next: asTarget(targets[i + 1]),
        });
        // Abortable, so a Stop button doesn't wait out a 7-minute gap.
        await delay(gapMs, undefined, { signal }).catch(() => {});
      }
    }

    // Enrichment phase: visit individual post pages for IG records still
    // missing fields, up to the per-run visit budget, respecting the
    // deadline and the abort signal like the main loop does.
    if (client && enrichQueue.length && !signal?.aborted && Date.now() <= deadline) {
      const enrichDeps = {
        navigate,
        evalJs,
        assertSafe,
        sleep,
        pageLoadDelayMs: S.pageLoadDelayMs,
        dwellMs: rand(S.initialDwellMs[0], S.initialDwellMs[1]),
        journal,
      };
      const visitCap = S.maxPostVisitsPerRun ?? 0;
      for (const rec of enrichQueue.slice(0, visitCap)) {
        if (signal?.aborted || Date.now() > deadline) break;
        try {
          const enriched = await enrichPost(client, rec, enrichDeps);
          await results.record(rec.hashtag, [enriched], runAt, window); // upsert fills fields
        } catch (err) {
          if (err instanceof BlockError) {
            status = "aborted";
            abortReason = err.reason ?? "unknown";
            let incidentDir = null;
            try {
              ({ incidentDir } = await captureIncident({
                root: config.root,
                runId: runAt,
                business: config.business,
                error: err,
                journal,
                client,
                caps,
                deps: { evalJs, screenshot: mcpScreenshot },
              }));
            } catch {
              /* swallow */
            }
            emit("danger", {
              reason: abortReason,
              url: err.url ?? null,
              message: err.message,
              incidentDir,
            });
            break;
          }
          journal?.log?.("post_visit", { detail: { id: rec.id, error: err.message } });
        }
        const gapMs = rand(S.gapBetweenHashtagsMs[0], S.gapBetweenHashtagsMs[1]);
        await delay(gapMs, undefined, { signal }).catch(() => {});
      }
    }
  } finally {
    // Must run: skipping it leaves a ghost MCP session that blocks the next run.
    await dx(client);
    await Promise.resolve(results.finish?.()).catch(() => {});
    releaseLock(lock);
  }

  journal?.log?.("run_end", { detail: { status } });
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
