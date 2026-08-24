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

/**
 * A listen failure must be loud.
 *
 * Windows binds the socket before it listens, so an occupied port is reported
 * asynchronously — after the banner above has already printed. Left unhandled
 * the error goes nowhere, the server handle is gone, and the only thing still
 * holding the event loop open is the pool's idle connection. Thirty seconds
 * later that times out, the loop drains and the process exits 0: a service that
 * announced itself, sat there looking healthy, then vanished without a word.
 */
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${port} is already in use — another scraper service is still running.`);
    console.error(`  find it:  netstat -ano | findstr :${port}`);
    console.error(`  stop it:  taskkill /PID <pid> /F`);
    console.error(`  or set SCRAPER_PORT in .env to a free port.`);
  } else {
    console.error(`\nthe service could not start: ${err.message}`);
  }
  process.exit(1);
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

/**
 * Keep serving through a stray rejection.
 *
 * A background write that nobody awaited — a heartbeat against a sleeping
 * database, say — must not end the process. It once did: one refused insert
 * killed the service mid-run and left the Chrome session held. Logging loudly
 * and staying up is strictly better here, because the operator needs the service
 * alive to see what happened and to stop the run cleanly.
 */
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection (service staying up):", reason);
});

/**
 * An uncaught exception is different: state is unknown, so continuing is not
 * safe. Release the browser first, then exit, rather than orphaning the session.
 */
process.on("uncaughtException", (err) => {
  console.error("uncaught exception:", err);
  void shutdown("uncaughtException");
});
