import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Config loading for multiple businesses. Importing this module has no side
 * effects, so the web app can read config without triggering a scrape.
 *
 * Layout:
 *   config.json            global: mcpEndpoint + safety only
 *   businesses/<slug>.json per business: { name, hashtags: [...] }
 *   data/<slug>/           per business: tally.csv, seen.json, posts/, run.lock
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
 * service and the test suite all resolve config.json, businesses/ and data/ to
 * the same place no matter where they were started from.
 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// tally.csv is written by plain string concatenation, so a comma or newline in a
// hashtag would corrupt it. Validating here is what keeps that safe.
const HASHTAG_RE = /^[A-Za-z0-9_.]+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;
const PLATFORMS = new Set(["instagram", "facebook"]);
const PAIR_KEYS = ["scrollPauseMs", "gapBetweenHashtagsMs", "initialDwellMs"];
const NUM_KEYS = ["maxHashtagsPerRun", "maxRunMinutes", "scrollsPerHashtag", "pageLoadDelayMs"];

export function businessesDir(root = ROOT) {
  return path.join(root, "businesses");
}

export function businessFile(slug, root = ROOT) {
  return path.join(businessesDir(root), `${slug}.json`);
}

export function businessDataDir(slug, root = ROOT) {
  return path.join(root, "data", slug);
}

export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Global settings shared by every business. */
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
  if (problems.length) {
    throw new Error(`config.json is invalid:\n  - ${problems.join("\n  - ")}`);
  }

  return {
    mcpEndpoint: raw.mcpEndpoint,
    safety: {
      maxHashtagsPerRun: safety.maxHashtagsPerRun,
      maxRunMinutes: safety.maxRunMinutes,
      scrollsPerHashtag: safety.scrollsPerHashtag,
      pageLoadDelayMs: safety.pageLoadDelayMs,
      scrollPauseMs: safety.scrollPauseMs,
      gapBetweenHashtagsMs: safety.gapBetweenHashtagsMs,
      initialDwellMs: safety.initialDwellMs,
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

/** Every business defined on disk, ordered by name. */
export function listBusinesses(root = ROOT) {
  const dir = businessesDir(root);
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
      });
    } catch {
      /* a malformed business file is skipped rather than breaking every read */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readBusiness(slug, root = ROOT) {
  return listBusinesses(root).find((b) => b.slug === slug) ?? null;
}

export function writeBusiness({ slug, name, hashtags = [], createdAt }, root = ROOT) {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid slug ${JSON.stringify(slug)} — use lowercase letters, digits, hyphens`);
  }
  if (typeof name !== "string" || !name.trim()) throw new Error("name is required");
  const problems = validateHashtags(hashtags);
  if (problems.length) throw new Error(`invalid hashtags:\n  - ${problems.join("\n  - ")}`);

  fs.mkdirSync(businessesDir(root), { recursive: true });
  fs.mkdirSync(businessDataDir(slug, root), { recursive: true });
  const existing = readBusiness(slug, root);
  const payload = {
    name: name.trim(),
    createdAt: createdAt ?? existing?.createdAt ?? new Date().toISOString(),
    hashtags: hashtags.map((h) => ({ platform: h.platform, value: h.value })),
  };
  fs.writeFileSync(businessFile(slug, root), `${JSON.stringify(payload, null, 2)}\n`);
  return { slug, ...payload };
}

/** Removes the business definition. Collected data is left in place on purpose. */
export function deleteBusiness(slug, root = ROOT) {
  fs.rmSync(businessFile(slug, root), { force: true });
}

/**
 * The config a run needs: global safety plus one business's hashtags, with that
 * business's own data directory (separate dedup memory and lock per business).
 */
export function loadConfig({ business, root = ROOT } = {}) {
  const global = loadGlobal(root);
  const all = listBusinesses(root);
  if (all.length === 0) {
    throw new Error(
      `no businesses defined. Create ${businessFile("<slug>", root)} with {name, hashtags}.`,
    );
  }
  const chosen = business ? all.find((b) => b.slug === business) : all[0];
  if (!chosen) {
    throw new Error(
      `unknown business ${JSON.stringify(business)}. Available: ${all.map((b) => b.slug).join(", ")}`,
    );
  }
  if (chosen.hashtags.length === 0) {
    throw new Error(`business ${chosen.slug} has no hashtags configured`);
  }

  return {
    mcpEndpoint: global.mcpEndpoint,
    safety: global.safety,
    business: chosen.slug,
    campaign: chosen.name,
    hashtags: chosen.hashtags,
    dataDir: businessDataDir(chosen.slug, root),
    root,
  };
}

export function hashtagUrl(h) {
  return h.platform === "instagram"
    ? `https://www.instagram.com/explore/tags/${h.value}/`
    : `https://www.facebook.com/search/posts?q=%23${encodeURIComponent(h.value)}`;
}
