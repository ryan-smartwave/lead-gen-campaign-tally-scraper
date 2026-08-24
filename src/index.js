import { setMaxListeners } from "node:events";
import { loadEnv, serverConfig } from "./config/env.js";
import { listBusinesses } from "./config/index.js";
import { isDbConfigured, closeDb } from "./db/pool.js";
import { isRunning, stop, refreshBusinessMirror } from "./services/supervisor.service.js";
import { campaignDay } from "./utils/day.js";
import { createApp } from "./app.js";

/**
 * Service entry point.
 *
 * setMaxListeners lives here rather than in the library: the MCP SDK registers a
 * per-request abort listener on the connection's AbortSignal, which exceeds
 * Node's default cap of 100 over a full run. Setting it inside a module would
 * impose it on any process that imported the library.
 */
setMaxListeners(0);
loadEnv();

const { host, port } = serverConfig();
const server = createApp().listen(port, host, () => {
  console.log(`scraper service listening on http://${host}:${port}`);
  console.log(`  database:     ${isDbConfigured() ? "configured" : "NOT configured — set DATABASE_URL"}`);
  console.log(`  businesses:   ${listBusinesses().length}`);
  console.log(`  campaign day: ${campaignDay()}`);
  // Best-effort, so the UI can read businesses without filesystem access.
  void refreshBusinessMirror().catch(() => {});
});

// A run holds the only Chrome session. Releasing it on the way out avoids
// leaving a ghost that blocks the next run.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received.`);
  if (isRunning()) {
    console.log("  stopping the in-flight run so Chrome is released ...");
    stop();
  }
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
  // Don't hang forever if a connection refuses to close.
  setTimeout(() => process.exit(0), 15_000).unref();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
