#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One-time migration from the single-campaign layout to per-business layout.
 *
 *   before: config.json {campaign, hashtags, safety, dataDir}  +  data/{tally.csv,...}
 *   after:  config.json {mcpEndpoint, safety}
 *           businesses/<slug>.json {name, hashtags}
 *           data/<slug>/{tally.csv, seen.json, posts/}
 *
 * Non-destructive: the original data directory is copied, not moved, and the old
 * config is kept as config.legacy.json. Re-running is a no-op.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configPath = path.join(root, "config.json");
const legacyPath = path.join(root, "config.legacy.json");
const dataDir = path.join(root, "data");

const dryRun = process.argv.includes("--dry-run");
const log = (msg) => console.log(`${dryRun ? "[dry-run] " : ""}${msg}`);

const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));

if (!raw.campaign && !raw.hashtags) {
  console.log("config.json is already in the global-only format; nothing to migrate.");
  process.exit(0);
}

const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

const name = raw.campaign ?? "Default";
const slug = slugify(name) || "default";
const targetData = path.join(dataDir, slug);

log(`business: "${name}" -> businesses/${slug}.json`);

// 1. Write the business definition.
const business = {
  name,
  createdAt: new Date().toISOString(),
  hashtags: (raw.hashtags ?? []).map((h) => ({ platform: h.platform, value: h.value })),
};
log(`  ${business.hashtags.length} hashtags`);
if (!dryRun) {
  fs.mkdirSync(path.join(root, "businesses"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "businesses", `${slug}.json`),
    `${JSON.stringify(business, null, 2)}\n`,
  );
}

// 2. Copy existing collected data into the business's own directory.
const movable = ["tally.csv", "seen.json", "posts"];
if (fs.existsSync(dataDir)) {
  for (const entry of movable) {
    const from = path.join(dataDir, entry);
    const to = path.join(targetData, entry);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) {
      log(`  skip ${entry} (already present in data/${slug}/)`);
      continue;
    }
    log(`  copy data/${entry} -> data/${slug}/${entry}`);
    if (!dryRun) {
      fs.mkdirSync(targetData, { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    }
  }
} else {
  log("  no existing data directory");
}

// 3. Reduce config.json to the global settings, keeping a copy of the old one.
const globalConfig = { mcpEndpoint: raw.mcpEndpoint, safety: raw.safety };
log("rewrite config.json as global-only (mcpEndpoint + safety); old copy -> config.legacy.json");
if (!dryRun) {
  if (!fs.existsSync(legacyPath)) fs.copyFileSync(configPath, legacyPath);
  fs.writeFileSync(configPath, `${JSON.stringify(globalConfig, null, 2)}\n`);
}

log("done.");
if (!dryRun) {
  console.log(
    `\nThe original files are still at data/ (copied, not moved) and config.legacy.json.\n` +
      `Once you've confirmed the app looks right, those can be deleted by hand.`,
  );
}
