import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Config loading for multiple campaigns. Importing this module has no side
 * effects, so the web app can read config without triggering a scrape.
 *
 * Layout:
 *   config.json            global: mcpEndpoint + safety only
 *   campaigns/<slug>.json per campaign: { name, hashtags: [...] }
 *   data/<slug>/           per campaign: tally.csv, seen.json, posts/, run.lock
 *
 * The split is deliberate. Hashtags are content and may be edited from the web
 * UI; `safety` is the anti-ban firewall and is file-only, with no write path
 * from the app — a UI that can widen those limits is a UI that can get the
 * account banned.
 */

/**
 * The repository root: three levels up from src/config/index.js.
 *
 * Derived from this module's own location rather than cwd, so the CLI, the
 * service and the test suite all resolve config.json, campaigns/ and data/ to
 * the same place no matter where they were started from.
 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// tally.csv is written by plain string concatenation, so a comma or newline in a
// hashtag would corrupt it. Validating here is what keeps that safe.
const HASHTAG_RE = /^[A-Za-z0-9_.]+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLATFORMS = new Set(["instagram", "facebook"]);
const PAIR_KEYS = ["scrollPauseMs", "gapBetweenHashtagsMs", "initialDwellMs"];
const NUM_KEYS = ["maxHashtagsPerRun", "maxRunMinutes", "scrollsPerHashtag", "pageLoadDelayMs"];

export function validateCampaignDates(campaignStart, campaignEnd) {
  const problems = [];
  const check = (label, v) => {
    if (v == null) return null;
    if (typeof v !== "string" || !DATE_RE.test(v) || isNaN(new Date(v).getTime())) {
      problems.push(`${label} must be an ISO date (YYYY-MM-DD) — got ${JSON.stringify(v)}`);
      return null;
    }
    return new Date(v);
  };
  const s = check("campaignStart", campaignStart);
  const e = check("campaignEnd", campaignEnd);
  if (s && e && s > e) problems.push("campaignStart must be on or before campaignEnd");
  return problems;
}

export function campaignsDir(root = ROOT) {
  return path.join(root, "campaigns");
}

export function campaignFile(slug, root = ROOT) {
  return path.join(campaignsDir(root), `${slug}.json`);
}

export function campaignDataDir(slug, root = ROOT) {
  return path.join(root, "data", slug);
}

export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Global settings shared by every campaign. */
export function loadGlobal(root = ROOT) {
  const file = path.join(root, "config.json");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`could not read ${file}: ${err.message}`);
  }

  const problems = [];
  if (!raw.mcpEndpoint) problems.push("mcpEndpoint is missing");

  const safety = raw.safety ?? {};
  for (const key of NUM_KEYS) {
    if (typeof safety[key] !== "number" || safety[key] <= 0) {
      problems.push(`safety.${key} must be a positive number`);
    }
  }
  for (const key of PAIR_KEYS) {
    const pair = safety[key];
    const ok =
      Array.isArray(pair) &&
      pair.length === 2 &&
      pair.every((n) => typeof n === "number" && n >= 0) &&
      pair[0] <= pair[1];
    if (!ok) problems.push(`safety.${key} must be [min, max] with min <= max`);
  }

  const OPT_NUM = {
    maxPostVisitsPerRun: 8,
    journalRetentionDays: 30,
    // Deep-scroll guards (0 disables either): stop a hashtag after this many
    // consecutive scroll steps that surface no new posts, and after this many
    // total posts. Only meaningful alongside scrollMinutesPerHashtag, but
    // harmless in step mode.
    dryStopAfterScrolls: 10,
    maxPostsPerHashtag: 3000,
  };
  for (const [key, def] of Object.entries(OPT_NUM)) {
    if (safety[key] === undefined) safety[key] = def;
    else if (typeof safety[key] !== "number" || safety[key] < 0) {
      problems.push(`safety.${key} must be a non-negative number`);
    }
  }

  // Optional [min, max] pairs. scrollMinutesPerHashtag switches the scroll to a
  // time budget (absent = legacy fixed step count); it is capped at 45 minutes
  // because past that a single "session" on one hashtag stops resembling any
  // human behavior at all. restEveryMs/restPauseMs add reading breaks inside a
  // long scroll and default on so deep mode can't be configured without them.
  const OPT_PAIRS = {
    scrollMinutesPerHashtag: null,
    restEveryMs: [150_000, 300_000],
    restPauseMs: [15_000, 45_000],
    // Pause between individual post visits in the enrichment phase. Its own
    // pacing on purpose: reusing the hashtag gap froze the run ~5 minutes
    // between two post clicks, which no human does.
    postVisitGapMs: [45_000, 120_000],
    // Gap when the NEXT hashtag is on the other platform. The platform being
    // left just started a rest that lasts the other platform's whole scroll,
    // so only a short human breather is needed at the switch itself.
    crossPlatformGapMs: [60_000, 150_000],
  };
  for (const [key, def] of Object.entries(OPT_PAIRS)) {
    if (safety[key] === undefined || safety[key] === null) {
      safety[key] = def;
      continue;
    }
    const pair = safety[key];
    const ok =
      Array.isArray(pair) &&
      pair.length === 2 &&
      pair.every((n) => typeof n === "number" && n > 0) &&
      pair[0] <= pair[1];
    if (!ok) problems.push(`safety.${key} must be [min, max] with 0 < min <= max`);
    else if (key === "scrollMinutesPerHashtag" && pair[1] > 45) {
      problems.push("safety.scrollMinutesPerHashtag max is capped at 45 minutes");
    }
  }
  if (safety.pipelineTabs === undefined) safety.pipelineTabs = true;
  else if (typeof safety.pipelineTabs !== "boolean") {
    problems.push("safety.pipelineTabs must be a boolean");
  }

  if (problems.length) {
    throw new Error(`config.json is invalid:\n  - ${problems.join("\n  - ")}`);
  }

  return {
    mcpEndpoint: raw.mcpEndpoint,
    safety: {
      maxHashtagsPerRun: safety.maxHashtagsPerRun,
      maxRunMinutes: safety.maxRunMinutes,
      scrollsPerHashtag: safety.scrollsPerHashtag,
      scrollMinutesPerHashtag: safety.scrollMinutesPerHashtag,
      pageLoadDelayMs: safety.pageLoadDelayMs,
      scrollPauseMs: safety.scrollPauseMs,
      restEveryMs: safety.restEveryMs,
      restPauseMs: safety.restPauseMs,
      dryStopAfterScrolls: safety.dryStopAfterScrolls,
      maxPostsPerHashtag: safety.maxPostsPerHashtag,
      gapBetweenHashtagsMs: safety.gapBetweenHashtagsMs,
      crossPlatformGapMs: safety.crossPlatformGapMs,
      postVisitGapMs: safety.postVisitGapMs,
      initialDwellMs: safety.initialDwellMs,
      maxPostVisitsPerRun: safety.maxPostVisitsPerRun,
      pipelineTabs: safety.pipelineTabs,
      journalRetentionDays: safety.journalRetentionDays,
    },
    root,
  };
}

export function validateHashtags(hashtags) {
  const problems = [];
  if (!Array.isArray(hashtags)) {
    problems.push("hashtags must be an array");
    return problems;
  }
  hashtags.forEach((h, i) => {
    if (!PLATFORMS.has(h?.platform)) {
      problems.push(`hashtags[${i}].platform must be "instagram" or "facebook"`);
    }
    if (typeof h?.value !== "string" || !HASHTAG_RE.test(h.value)) {
      problems.push(
        `hashtags[${i}].value must match ${HASHTAG_RE} (no "#", no commas) — got ${JSON.stringify(h?.value)}`,
      );
    }
  });
  const seen = new Set();
  for (const h of hashtags) {
    const key = `${h?.platform}:${h?.value}`;
    if (seen.has(key)) problems.push(`duplicate hashtag ${key}`);
    seen.add(key);
  }
  return problems;
}

/** Every campaign defined on disk, ordered by name. */
export function listCampaigns(root = ROOT) {
  const dir = campaignsDir(root);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    const slug = file.replace(/\.json$/, "");
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      out.push({
        slug,
        name: raw.name ?? slug,
        hashtags: (raw.hashtags ?? []).map((h) => ({ platform: h.platform, value: h.value })),
        createdAt: raw.createdAt ?? null,
        campaignStart: raw.campaignStart ?? null,
        campaignEnd: raw.campaignEnd ?? null,
      });
    } catch {
      /* a malformed campaign file is skipped rather than breaking every read */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readCampaign(slug, root = ROOT) {
  return listCampaigns(root).find((b) => b.slug === slug) ?? null;
}

export function writeCampaign({ slug, name, hashtags = [], createdAt, campaignStart, campaignEnd }, root = ROOT) {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid slug ${JSON.stringify(slug)} — use lowercase letters, digits, hyphens`);
  }
  if (typeof name !== "string" || !name.trim()) throw new Error("name is required");
  const problems = validateHashtags(hashtags);
  if (problems.length) throw new Error(`invalid hashtags:\n  - ${problems.join("\n  - ")}`);

  const dateProblems = validateCampaignDates(campaignStart, campaignEnd);
  if (dateProblems.length) throw new Error(`invalid campaign dates:\n  - ${dateProblems.join("\n  - ")}`);

  fs.mkdirSync(campaignsDir(root), { recursive: true });
  fs.mkdirSync(campaignDataDir(slug, root), { recursive: true });
  const existing = readCampaign(slug, root);
  const payload = {
    name: name.trim(),
    createdAt: createdAt ?? existing?.createdAt ?? new Date().toISOString(),
    hashtags: hashtags.map((h) => ({ platform: h.platform, value: h.value })),
    campaignStart: campaignStart ?? existing?.campaignStart ?? null,
    campaignEnd: campaignEnd ?? existing?.campaignEnd ?? null,
  };
  fs.writeFileSync(campaignFile(slug, root), `${JSON.stringify(payload, null, 2)}\n`);
  return { slug, ...payload };
}

/** Removes the campaign definition. Collected data is left in place on purpose. */
export function deleteCampaign(slug, root = ROOT) {
  fs.rmSync(campaignFile(slug, root), { force: true });
}

/**
 * The config a run needs: global safety plus one campaign's hashtags, with that
 * campaign's own data directory (separate dedup memory and lock per campaign).
 */
export function loadConfig({ campaign, root = ROOT } = {}) {
  const global = loadGlobal(root);
  const all = listCampaigns(root);
  if (all.length === 0) {
    throw new Error(
      `no campaigns defined. Create ${campaignFile("<slug>", root)} with {name, hashtags}.`,
    );
  }
  const chosen = campaign ? all.find((b) => b.slug === campaign) : all[0];
  if (!chosen) {
    throw new Error(
      `unknown campaign ${JSON.stringify(campaign)}. Available: ${all.map((b) => b.slug).join(", ")}`,
    );
  }
  if (chosen.hashtags.length === 0) {
    throw new Error(`campaign ${chosen.slug} has no hashtags configured`);
  }

  return {
    mcpEndpoint: global.mcpEndpoint,
    safety: global.safety,
    campaign: chosen.slug,
    campaignName: chosen.name,
    hashtags: chosen.hashtags,
    campaignStart: chosen.campaignStart ?? null,
    campaignEnd: chosen.campaignEnd ?? null,
    dataDir: campaignDataDir(chosen.slug, root),
    root,
  };
}

// Facebook's search accepts a base64 `filters` param carrying an
// rp_creation_time range at day granularity (verified live 2026-08-27: a
// June-only window changed the result set). FB's own UI emits unpadded
// month/day values ("2026-6", "2026-6-1"), so match that exactly.
function fbDateFilters(window) {
  const part = (d) => ({
    year: String(d.getUTCFullYear()),
    month: `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`,
    day: `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`,
  });
  const s = part(window.start);
  const e = part(window.end);
  const args = JSON.stringify({
    start_year: s.year, start_month: s.month, start_day: s.day,
    end_year: e.year, end_month: e.month, end_day: e.day,
  });
  const outer = JSON.stringify({
    "rp_creation_time:0": JSON.stringify({ name: "creation_time", args }),
  });
  return Buffer.from(outer).toString("base64");
}

/**
 * The URL a hashtag visit navigates to. `window` ({start, end} Dates, from
 * parseWindow) narrows Facebook results to the campaign window — only when
 * both bounds exist, since that is the only shape verified against the live
 * endpoint. Instagram's search has no date facility; the window is ignored.
 */
export function hashtagUrl(h, window = null) {
  if (h.platform === "instagram") {
    return `https://www.instagram.com/explore/tags/${h.value}/`;
  }
  const base = `https://www.facebook.com/search/posts?q=%23${encodeURIComponent(h.value)}`;
  if (!window?.start || !window?.end) return base;
  return `${base}&filters=${encodeURIComponent(fbDateFilters(window))}`;
}
