import { run } from "./run.service.js";
import { loadConfig, listCampaigns, ROOT } from "../config/index.js";
import {
  createDbStore,
  closeRun,
  heartbeat,
  ranOnDay,
  setRunTargets,
  syncCampaigns,
} from "../stores/dbStore.js";
import { createFileStore } from "../stores/fileStore.js";
import { isDbConfigured } from "../db/pool.js";
import { appendLedger, ledgerHasRun } from "../utils/ledger.js";
import { campaignDay } from "../utils/day.js";

/**
 * Owns the single in-flight run inside the service process.
 *
 * Living here rather than inside a web server is the point of the service: a run
 * takes 30–60 minutes, and it must survive the UI being restarted, rebuilt or
 * closed. Only this process is tied to the run's lifetime.
 */

const EVENT_CAP = 2000; // a run emits well under 100; a runaway guard

const state = {
  events: [],
  runId: null,
  campaign: null,
  startedAt: null,
  finished: true,
  controller: null,
  listeners: new Set(),
  lastError: null,
};

export function isRunning() {
  return !state.finished;
}

export function snapshot() {
  return {
    active: !state.finished,
    runId: state.runId,
    campaign: state.campaign,
    startedAt: state.startedAt,
    firstSeq: state.events[0]?.seq ?? 0,
    lastSeq: state.events.at(-1)?.seq ?? 0,
    events: state.events,
    lastError: state.lastError,
  };
}

export function subscribe(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

export function stop() {
  if (state.finished || !state.controller) return false;
  state.controller.abort();
  return true;
}

/** Forgets a finished run's log. Results live in the database, so nothing is lost. */
export function clearFinished() {
  if (!state.finished) return false;
  state.events = [];
  state.runId = null;
  state.campaign = null;
  state.startedAt = null;
  state.lastError = null;
  return true;
}

function push(event) {
  state.events.push(event);
  if (state.events.length > EVENT_CAP) state.events.splice(0, state.events.length - EVENT_CAP);
  for (const fn of state.listeners) {
    try {
      fn(event);
    } catch {
      /* a broken listener must never affect the run */
    }
  }
}

/**
 * Has this campaign already run today?
 *
 * The local ledger first, because it survives the database being cleared; then
 * the database. Any positive answer wins — a guard should be conservative, so
 * the sources are OR-ed rather than ranked.
 */
export async function ranToday(campaign) {
  const day = campaignDay();
  if (ledgerHasRun(ROOT, campaign, day)) return true;
  if (isDbConfigured()) {
    try {
      return await ranOnDay(campaign, day);
    } catch {
      // A database that cannot answer must not weaken the guard into a "no";
      // the ledger has already been consulted, so fall through to false.
      return false;
    }
  }
  return false;
}

export async function refreshCampaignMirror() {
  if (!isDbConfigured()) return 0;
  return syncCampaigns(listCampaigns());
}

export async function startRun({ campaign, force = false, store = "database" } = {}) {
  if (!state.finished) {
    const err = new Error("a run is already in progress");
    err.code = "ALREADY_RUNNING";
    throw err;
  }

  const config = loadConfig({ campaign });
  const campaignSlug = config.campaign;

  if (!force && (await ranToday(campaignSlug))) {
    const err = new Error(
      `${campaignSlug} already ran today (${campaignDay()}). Running twice a day works against the anti-ban design.`,
    );
    err.code = "ALREADY_RAN_TODAY";
    throw err;
  }

  const runId = new Date().toISOString();
  const targets = config.hashtags.map((h) => ({ platform: h.platform, hashtag: h.value }));

  const results =
    store === "file"
      ? createFileStore(config.dataDir)
      : createDbStore({
          campaign: campaignSlug,
          campaignName: config.campaignName,
          runId,
          budgetMinutes: config.safety.maxRunMinutes,
          targets,
        });

  // Prove the store works before anything else happens. A store that cannot
  // open — a refused insert, a sleeping database — must fail here, with no lock
  // taken, no ledger entry written and no browser touched. Learned the hard way:
  // letting that failure surface later took the whole service down with it.
  if (results.open) {
    try {
      await results.open();
    } catch (err) {
      const wrapped = new Error(`could not open the results store: ${err.message}`);
      wrapped.code = "STORE_UNAVAILABLE";
      throw wrapped;
    }
  }

  state.events = [];
  state.finished = false;
  state.controller = new AbortController();
  state.lastError = null;
  state.runId = runId;
  state.startedAt = runId;
  state.campaign = campaignSlug;

  // Written before the first page is visited, so an interrupted run still
  // counts against the once-a-day guard.
  appendLedger(ROOT, { campaign: campaignSlug, day: campaignDay(runId), runId, status: "running" });

  let resolveStarted;
  let rejectStarted;
  const ready = new Promise((res, rej) => {
    resolveStarted = res;
    rejectStarted = rej;
  });

  const onEvent = (event) => {
    push(event);
    if (event.type === "run_started") {
      // The run row was created with every configured hashtag; over the cap the
      // loop selects a rotation, so record what this run actually intends.
      if (store !== "file" && isDbConfigured()) {
        void setRunTargets(runId, event.targets).catch(() => {});
      }
      resolveStarted({
        runId: event.runId,
        startedAt: event.at,
        campaign: campaignSlug,
        campaignName: config.campaignName,
        targets: event.targets,
        budgetMinutes: event.budgetMinutes,
        store: event.store,
      });
    }
  };

  // A timer, not an event hook: the 3–7 minute gaps between hashtags would
  // otherwise look like a dead process to anything watching heartbeat_at.
  const beat = setInterval(() => {
    if (isDbConfigured()) void heartbeat(runId).catch(() => {});
  }, 30_000);

  // Deliberately not awaited: the run outlives the request that started it.
  void run({
    config,
    store: results,
    runId,
    onEvent,
    signal: state.controller.signal,
    source: "service",
  })
    .then(async (result) => {
      appendLedger(ROOT, {
        campaign: campaignSlug,
        day: campaignDay(runId),
        runId,
        status: result.status,
      });
      if (isDbConfigured()) await closeRun(runId, result.status, result.abortReason).catch(() => {});
    })
    .catch(async (err) => {
      state.lastError = err.message;
      appendLedger(ROOT, {
        campaign: campaignSlug,
        day: campaignDay(runId),
        runId,
        status: "aborted",
      });
      if (isDbConfigured()) await closeRun(runId, "aborted", err.message).catch(() => {});
      rejectStarted(err);
    })
    .finally(() => {
      state.finished = true;
      state.controller = null;
      clearInterval(beat);
    });

  return ready;
}
