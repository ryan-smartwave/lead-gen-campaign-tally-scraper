import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  connect,
  disconnect,
  evalJs,
  sleep,
  detectCaps,
  screenshot as mcpScreenshot,
  startNetCapture,
  stopNetCapture,
  resumeNetCapture,
  switchTab,
  closeTabs,
} from "./mcp.service.js";
import { IG_EXTRACT, FB_EXTRACT } from "./extract.service.js";
import {
  IG_CAPTURE_INSTALL,
  IG_CAPTURE_HARVEST,
  IG_CAPTURE_DRAIN,
  FB_CAPTURE_HARVEST,
  FB_CAPTURE_DRAIN,
  normalizeCaptured,
  normalizeFbCaptured,
  mergeRecords,
  mergeFbRecords,
  blobsFromNetworkCapture,
  decodeCandidateUrls,
  decodeImageUrl,
} from "./capture.service.js";
import { selectForEnrichment, enrichPost } from "./enrich.service.js";
import { createJournal } from "./journal.service.js";
import { captureIncident } from "./incident.service.js";
import { planNext } from "./pipeline.service.js";
import { parseWindow } from "../utils/freshness.js";
import { extractOtherHashtags } from "../utils/hashtags.js";
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
   Guards the BROWSER, not the data. Every campaign shares one Chrome session
   and one mcp-chrome bridge, so the lock is global rather than per campaign —
   two campaigns running at once would fight over the same tab. It also spans
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

/**
 * Open `url` with passive network capture running, so the page's initial API
 * burst is recorded (Instagram serves the grid data over /api/graphql at load;
 * an in-page patch installed afterwards can never see it). Returns the capture
 * tab id (or true if the extension didn't report one) when capture is live,
 * null when it isn't — in which case the caller must navigate itself.
 */
export async function openWithCapture(client, url, journal, retryDelayMs = 2000) {
  // One retry: real runs show the start refusing transiently (a previous
  // capture still detaching), and a silent null here costs every rich field
  // for the visit — Instagram has no other passive channel (the page binds
  // fetch at bootstrap, so the in-page hook never sees its traffic).
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { tabId } = await startNetCapture(client, url);
      // The extension may open the page in a fresh tab that isn't focused;
      // evalJs and the danger checks act on the ACTIVE tab, so make it so.
      if (tabId != null) await switchTab(client, tabId).catch(() => {});
      journal?.log?.("capture_start", { detail: { url, tabId, attempt } });
      return tabId ?? true;
    } catch (err) {
      // Loud, not silent: a missing capture_start in the journal was the only
      // trace of why a whole visit had no usernames/likes/captions.
      journal?.log?.("capture_start_failed", {
        detail: { url, attempt, message: err?.message?.slice(0, 200) },
      });
      if (attempt === 1) await sleep(retryDelayMs);
    }
  }
  return null; // capture unavailable — plain navigation still works
}

export async function collect(client, h, safety, ctx = {}) {
  const { journal, preloaded, seenIds, window = null, fbLocationId = null } = ctx;
  // Out-channel: how the scroll ended, for the run loop's hashtag_done event.
  const meta = ctx.meta ?? {};
  // Number = capture live in that tab; true = live, tab unknown; null = none.
  let captureTab = preloaded ? (h.__captureTab ?? null) : null;
  if (!preloaded) {
    // Both platforms serve their result data over /api/graphql, so both get
    // the passive debugger capture wrapped around navigation.
    captureTab = await openWithCapture(client, hashtagUrl(h, window, fbLocationId), journal);
    if (captureTab == null) await navigate(client, hashtagUrl(h, window, fbLocationId));
    journal?.log?.("navigate", { platform: h.platform, hashtag: h.value });
  } else {
    // The page is already loaded from the preceding gap's preload — nothing to
    // navigate. But minutes have passed since the preload focused our tab, and
    // evalJs acts on the ACTIVE tab: if the user opened or focused anything in
    // the meantime, the probe below runs against their tab (a real run died on
    // "Cannot access a chrome:// URL" exactly this way). Re-front ours first.
    if (typeof captureTab === "number") await switchTab(client, captureTab).catch(() => {});
    journal?.log?.("tab_switch", { platform: h.platform, hashtag: h.value });
  }
  await sleep(safety.pageLoadDelayMs);
  try {
    await assertSafe(client, `${h.platform}#${h.value} load`);
  } catch (err) {
    // A BlockError is a platform danger sign — never swallowed. Anything else
    // here is the probe itself failing, usually because focus drifted to a tab
    // we cannot script (chrome://). If we know our tab, re-front it and retry
    // once; otherwise the hashtag fails as before.
    if (err instanceof BlockError || typeof captureTab !== "number") throw err;
    journal?.log?.("refocus", {
      platform: h.platform,
      hashtag: h.value,
      detail: { message: err?.message?.slice(0, 160) },
    });
    await switchTab(client, captureTab);
    await sleep(1000);
    await assertSafe(client, `${h.platform}#${h.value} load (refocused)`);
  }

  // Belt-and-braces alongside network capture: catches scroll-triggered
  // requests if capture could not start. Idempotent (guarded by
  // `if(!window.__swCapture)`), so calling it again is harmless. The keep()
  // filter matches both platforms' /api/graphql traffic.
  await evalJs(client, IG_CAPTURE_INSTALL).catch(() => {});
  await jitter(safety.initialDwellMs);
  journal?.log?.("dwell", { platform: h.platform, hashtag: h.value });

  // Extract incrementally — before scrolling and again after every step. Both
  // platforms virtualize their feeds (posts scrolled past leave the DOM), so a
  // single extraction at the end sees only the last viewport-and-a-bit and
  // loses most of what scrolled by. Reading the DOM costs no network requests.
  const extractScript = h.platform === "instagram" ? IG_EXTRACT : FB_EXTRACT;
  const byId = new Map();
  // absorb returns how many posts this read added that the CAMPAIGN hasn't
  // recorded in any previous run (falling back to run-local newness when the
  // store gave no history). This is what the dry-stop counts: on day 30 the
  // top of a hashtag feed is mostly posts already archived, and a scroll that
  // keeps burning requests on them is spending risk on nothing — the frontier
  // between known and unknown posts is where scrolling should end.
  const known = seenIds instanceof Set ? seenIds : null;
  const absorb = (r) => {
    if (r?.loggedOut) {
      throw new BlockError(`not logged in to ${h.platform}`, {
        reason: "login_wall",
        url: hashtagUrl(h),
      });
    }
    let unseen = 0;
    for (const p of r?.posts ?? []) {
      if (byId.has(p.id)) continue;
      byId.set(p.id, p);
      if (!known || !known.has(p.id)) unseen++;
    }
    return unseen;
  };
  absorb(await evalJs(client, extractScript));

  // Deep mode: a [min, max] minutes pair budgets the scroll by time instead of
  // a step count. The debugger capture is the ONLY passive channel that sees
  // Instagram's pagination (the page binds fetch at bootstrap, so the in-page
  // hook is blind to IG traffic), so it must span the whole scroll — but a
  // 20+ minute capture stopped once would hand back a payload the bridge
  // guts. So it is CYCLED: at every drain point the capture is stopped, its
  // ~1 minute of bodies collected, and capture restarted on the same tab.
  // Purely observational either way — not one extra request in any cycle.
  const deep = Array.isArray(safety.scrollMinutesPerHashtag);
  const netBlobs = [];
  let captureLive = captureTab != null;
  const drainCapture = async (resume) => {
    if (!captureLive) return;
    captureLive = false;
    try {
      netBlobs.push(...blobsFromNetworkCapture(await stopNetCapture(client)));
    } catch {
      /* capture already expired or detached — nothing to collect this cycle */
    }
    if (!resume) return;
    try {
      await resumeNetCapture(client);
      captureLive = true;
    } catch (err) {
      // Restart unsupported or refused: keep what we have. Later drains
      // no-op and the visit degrades to initial-burst coverage only.
      journal?.log?.("capture_resume_failed", {
        detail: { message: err?.message?.slice(0, 200) },
      });
    }
  };

  const minis = []; // accumulated drain batches (arrays of compact records)
  let dryStreak = 0;
  let drains = 0;
  const dryLimit = safety.dryStopAfterScrolls ?? 0; // 0 = never stop on a dry feed
  const postCap = safety.maxPostsPerHashtag ?? 0; // 0 = uncapped
  const DRAIN_EVERY = 10; // scroll steps between drains (~1 min at the default pause)

  await humanScroll(
    client,
    {
      steps: safety.scrollsPerHashtag,
      minutes: deep ? safety.scrollMinutesPerHashtag : null,
      scrollPauseMs: safety.scrollPauseMs,
      restEveryMs: safety.restEveryMs,
      restPauseMs: safety.restPauseMs,
    },
    journal,
    async (i) => {
      const unseen = absorb(await evalJs(client, extractScript).catch(() => null)) ?? 0;
      dryStreak = unseen > 0 ? 0 : dryStreak + 1;
      if (deep && (i + 1) % DRAIN_EVERY === 0) {
        // Collect this cycle's network bodies and restart capture (see above).
        await drainCapture(true);
        try {
          const ig = h.platform === "instagram";
          const raw = await evalJs(client, ig ? IG_CAPTURE_DRAIN : FB_CAPTURE_DRAIN);
          // IG image urls decode here; FB records decode inside normalizeFbCaptured.
          const recs = ig
            ? decodeCandidateUrls(raw?.records)
            : Array.isArray(raw?.records) ? raw.records : [];
          if (recs.length) minis.push(recs);
          drains++;
        } catch {
          /* a failed drain only loses that slice — the final harvest still runs */
        }
        // A soft block that appears 4 minutes into a 25-minute scroll must
        // abort then, not when the scroll ends. Throws BlockError on danger.
        await assertSafe(client, `${h.platform}#${h.value} mid-scroll`);
      }
      meta.scrollSteps = i + 1;
      if (dryLimit && dryStreak >= dryLimit) {
        // The feed stopped serving new posts — exhausted or soft-limited.
        // Continuing to hammer an empty feed gains nothing and looks like a
        // bot that can't take a hint, so the hashtag ends early.
        journal?.log?.("scroll_dry", {
          platform: h.platform,
          hashtag: h.value,
          detail: { steps: i + 1, posts: byId.size },
        });
        meta.stopReason = "dry";
        return false;
      }
      if (postCap && byId.size >= postCap) {
        journal?.log?.("scroll_target", {
          platform: h.platform,
          hashtag: h.value,
          detail: { steps: i + 1, posts: byId.size },
        });
        meta.stopReason = "post_cap";
        return false;
      }
    },
  );
  // No early stop recorded means the scroll ran out its allotment.
  if (!meta.stopReason) meta.stopReason = deep ? "budget" : "steps";
  await assertSafe(client, `${h.platform}#${h.value} after-scroll`);
  const res = { posts: [...byId.values()] };

  if (h.platform === "instagram") {
    // Sources merged by shortcode with richer sightings winning: the network
    // capture's unredacted bodies (initial burst + every scroll cycle), the
    // per-drain batches, and a final in-page harvest (remaining ring buffer +
    // inline Relay JSON — raw blobs can't be shipped, the bridge truncates them).
    await drainCapture(false); // final collection, no restart
    let finalMinis = [];
    try {
      const raw = await evalJs(client, IG_CAPTURE_HARVEST);
      finalMinis = decodeCandidateUrls(raw?.records);
    } catch {
      /* degrade gracefully */
    }
    const captured = normalizeCaptured({ responses: [...netBlobs, ...minis, finalMinis], inline: [] });
    journal?.log?.("capture_harvest", {
      platform: h.platform,
      hashtag: h.value,
      detail: {
        records: captured.length,
        inPage: minis.reduce((n, b) => n + b.length, finalMinis.length),
        drains,
        netBlobs: netBlobs.length,
      },
    });
    // The capture opened its own tab; close it so daily runs don't pile up
    // dozens of leftover automation tabs in the user's browser.
    if (typeof captureTab === "number") {
      await closeTabs(client, [captureTab]).catch(() => {});
    }
    const domPosts = res.posts.map((p) => ({ ...p, imageUrl: decodeImageUrl(p.imageUrl) }));
    return mergeRecords(domPosts, captured);
  }

  // Facebook: the same two-source merge, matched by message text instead of
  // shortcode (FB cards expose no stable URL in the DOM — the captured
  // stories carry the real permalink, the full past-"See more" message,
  // actor, reaction/comment counts and image).
  await drainCapture(false); // final collection, no restart
  let finalMinis = [];
  try {
    const raw = await evalJs(client, FB_CAPTURE_HARVEST);
    if (Array.isArray(raw?.records)) finalMinis = raw.records;
  } catch {
    /* degrade gracefully — DOM-only records still count */
  }
  const captured = normalizeFbCaptured({ responses: [...netBlobs, ...minis, finalMinis] });
  journal?.log?.("capture_harvest", {
    platform: h.platform,
    hashtag: h.value,
    detail: {
      records: captured.length,
      inPage: minis.reduce((n, b) => n + b.length, finalMinis.length),
      drains,
      netBlobs: netBlobs.length,
    },
  });
  if (typeof captureTab === "number") {
    await closeTabs(client, [captureTab]).catch(() => {});
  }
  const domPosts = res.posts.map((p) => ({ ...p, imageUrl: decodeImageUrl(p.imageUrl) }));
  return mergeFbRecords(domPosts, captured);
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
/**
 * Interleave the two platforms so consecutive visits alternate whenever both
 * have targets left. Each platform then rests for the other platform's whole
 * scroll between its own visits — better per-platform spacing than any gap
 * buys — which is what makes the short cross-platform gap safe. Relative
 * order within a platform is preserved (callers shuffle first), and when the
 * counts are uneven the surplus lands at the end as same-platform neighbors,
 * which the gap picker charges the full same-platform gap for.
 */
export function alternatePlatforms(targets) {
  const groups = new Map();
  for (const t of targets) {
    if (!groups.has(t.platform)) groups.set(t.platform, []);
    groups.get(t.platform).push(t);
  }
  const lists = [...groups.values()].sort((a, b) => b.length - a.length);
  const out = [];
  for (let i = 0; i < (lists[0]?.length ?? 0); i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]);
  }
  return out;
}

/**
 * The gap range before visiting `next`: switching platforms takes the short
 * breather (the platform being left is resting either way); staying on the
 * same platform keeps the full search-pacing gap.
 */
export function gapRangeFor(current, next, safety) {
  const cross = current?.platform !== next?.platform;
  return cross && safety.crossPlatformGapMs
    ? safety.crossPlatformGapMs
    : safety.gapBetweenHashtagsMs;
}

export async function selectTargets(hashtags, cap, store) {
  if (hashtags.length <= cap) return alternatePlatforms(shuffle(hashtags));

  let visits = null;
  try {
    visits = store?.lastVisits ? await store.lastVisits(hashtags) : null;
  } catch {
    visits = null;
  }
  if (!visits) return alternatePlatforms(shuffle(hashtags).slice(0, cap));

  // ISO timestamps compare lexically; "" sorts never-visited first. The sort is
  // stable, so pre-shuffling randomizes the order among equal visit times.
  const last = (h) => visits[`${h.platform}:${h.value}`] ?? "";
  const chosen = shuffle(hashtags)
    .sort((a, b) => (last(a) < last(b) ? -1 : last(a) > last(b) ? 1 : 0))
    .slice(0, cap);
  return alternatePlatforms(shuffle(chosen));
}

/* ---------------- the run ---------------- */

/**
 * @param {object} opts
 * @param {object} opts.config       from loadConfig()
 * @param {object} [opts.store]      storage backend; defaults to files in config.dataDir
 * @param {(e:object)=>void} [opts.onEvent]
 * @param {AbortSignal} [opts.signal] cooperative stop between hashtags
 * @param {'web'|'cli'} [opts.source]
 * @param {object} [opts.deps]       test seams: {connect, disconnect, collect, enrichPost}
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
  const ep = deps.enrichPost ?? enrichPost;

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
    campaign: config.campaign,
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
    campaignName: config.campaignName,
    campaign: config.campaign,
    store: results.kind ?? "unknown",
    targets: targets.map(asTarget),
    budgetMinutes: S.maxRunMinutes,
  });

  try {
    client = await cx(config.mcpEndpoint, {
      onEvent: (e) => emit("connect_retry", e),
    });

    caps = await detectCaps(client).catch(() => ({ tabs: false, screenshot: false }));
    if (!S.pipelineTabs) caps.tabs = false;

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
      const visitStart = Date.now();

      try {
        // The campaign's known post ids for this hashtag, so the collector can
        // stop at the frontier of what's new. Best-effort: a store without
        // history (or a failing lookup) just means the full scroll budget runs.
        let seenIds = null;
        try {
          const ids = await results.seenIds?.(h);
          if (Array.isArray(ids)) seenIds = new Set(ids);
        } catch {
          seenIds = null;
        }
        // meta is collect's out-channel: it fills in how the scroll ended
        // (stopReason/scrollSteps) so the UI can say WHY a visit was short.
        const meta = {};
        const posts = await co(client, h, S, {
          journal, caps, preloaded: h.__preloaded, seenIds, window,
          fbLocationId: config.fbLocationId ?? null,
          meta,
        });
        for (const p of posts) {
          p.otherHashtags = extractOtherHashtags(
            [p.caption, p.text, p.preview].filter(Boolean).join(" "),
            h.value,
          );
        }
        const { newCount, freshCount, cumulative } = await results.record(h, posts, runAt, window);
        const rowStatus = posts.length ? "ok" : "empty";
        const durationSeconds = Math.round((Date.now() - visitStart) / 1000);
        await results.writeRow(h, runAt, {
          newCount,
          freshCount,
          cumulative,
          status: rowStatus,
          postsOnPage: posts.length,
          visitSeq: i + 1,
          durationSeconds,
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
          durationSeconds,
          stopReason: meta.stopReason,
          scrollSteps: meta.scrollSteps,
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
              durationSeconds: Math.round((Date.now() - visitStart) / 1000),
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
              campaign: config.campaign,
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
        const plan = planNext({
          index: i, targets, caps, downgraded, window,
          fbLocationId: config.fbLocationId ?? null,
        });
        if (plan.preload) {
          try {
            // Capture must be running when the page loads — that is when both
            // platforms fetch their result data. openWithCapture navigates.
            const capTab = await openWithCapture(client, plan.url, journal);
            if (capTab == null) await navigate(client, plan.url);
            targets[i + 1].__captureTab = capTab;
            await evalJs(client, IG_CAPTURE_INSTALL).catch(() => {});
            targets[i + 1].__preloaded = true;
            journal?.log?.("preload", { detail: { url: plan.url } });
          } catch {
            // Pipelining is a refinement, never something that can abort a
            // run: downgrade to plain sequential visits for the rest of it.
            downgraded = true;
            journal?.log?.("downgrade", { detail: { reason: "preload_failed" } });
          }
        }
        const gapRange = gapRangeFor(targets[i], targets[i + 1], S);
        const gapMs = rand(gapRange[0], gapRange[1]);
        journal?.log?.("gap", {
          detail: { ms: gapMs, cross: targets[i].platform !== targets[i + 1].platform },
        });
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
    // deadline and the abort signal like the main loop does. Gated on
    // status === "complete" — abort-never-retry (ANTIBAN.md §7) means a
    // BlockError or a spent time budget in the main loop must never be
    // followed by MORE navigation, even to a different URL.
    if (client && enrichQueue.length && status === "complete" && !signal?.aborted && Date.now() > deadline) {
      // The budget ran out before enrichment could even start — same
      // outcome, per the spec's error table, as running out mid-loop below.
      status = "budget_stopped";
    }
    if (client && enrichQueue.length && status === "complete" && !signal?.aborted) {
      const visitCap = S.maxPostVisitsPerRun ?? 0;
      for (const rec of enrichQueue.slice(0, visitCap)) {
        if (signal?.aborted) break;
        if (Date.now() > deadline) {
          status = "budget_stopped";
          break;
        }
        // Resampled every visit, like the gap below — a fixed dwell across
        // every post page is itself a fixed-interval bot signature.
        const enrichDeps = {
          navigate,
          evalJs,
          assertSafe,
          sleep,
          pageLoadDelayMs: S.pageLoadDelayMs,
          dwellMs: rand(S.initialDwellMs[0], S.initialDwellMs[1]),
          journal,
          openWithCapture: (cl, url) => openWithCapture(cl, url, journal),
          stopCapture: async (cl) => blobsFromNetworkCapture(await stopNetCapture(cl)),
          closeTab: (cl, tabId) => closeTabs(cl, [tabId]),
        };
        try {
          const enriched = await ep(client, rec, enrichDeps);
          // Enrichment may be what finally supplies the caption, so the
          // other-hashtags derivation reruns on the merged record.
          enriched.otherHashtags = extractOtherHashtags(
            [enriched.caption, enriched.text, enriched.preview].filter(Boolean).join(" "),
            rec.hashtag.value,
          );
          // NOT results.record: a dedup-by-id store already saw this post's
          // id from the main loop and would silently drop a second `record`
          // call. `enrich` merges the extra fields into what's already there.
          await results.enrich?.(rec.hashtag, enriched, runAt);
        } catch (err) {
          if (err instanceof BlockError) {
            status = "aborted";
            abortReason = err.reason ?? "unknown";
            let incidentDir = null;
            try {
              ({ incidentDir } = await captureIncident({
                root: config.root,
                runId: runAt,
                campaign: config.campaign,
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
              platform: rec.hashtag.platform,
              hashtag: rec.hashtag.value,
              reason: abortReason,
              url: err.url ?? null,
              message: err.message,
              incidentDir,
            });
            break;
          }
          journal?.log?.("post_visit", { detail: { id: rec.id, error: err.message } });
        }
        // Post visits get their own, much shorter pacing — a human clicking
        // through a few posts does not freeze for five minutes between them.
        const visitGap = S.postVisitGapMs ?? S.gapBetweenHashtagsMs;
        const gapMs = rand(visitGap[0], visitGap[1]);
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
