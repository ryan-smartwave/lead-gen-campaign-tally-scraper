import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./index.js";

/**
 * Environment settings for the service.
 *
 * Reads .env from the repository root without adding a dependency — one small
 * parser is cheaper than dotenv for a handful of keys.
 */

export function loadEnv(root = ROOT) {
  for (const name of [".env", ".env.local"]) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, "");
      // Real environment variables win over the file.
      if (value && !process.env[m[1]]) process.env[m[1]] = value;
    }
  }
}

export function serverConfig() {
  return {
    host: process.env.SCRAPER_HOST ?? "127.0.0.1",
    port: Number(process.env.SCRAPER_PORT ?? 3900),
    // Browser origins allowed to call the service. The UI's dev server by
    // default; anything else must be listed explicitly.
    allowedOrigins: (
      process.env.SCRAPER_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
