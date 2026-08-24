import path from "node:path";
import { setMaxListeners } from "node:events";
import { loadConfig, listBusinesses, ROOT } from "../src/config/index.js";
import { run, check } from "../src/services/run.service.js";

/**
 * CLI entrypoint. All the work lives in run.js; this file only parses argv and
 * turns run events back into the exact lines this tool has always printed.
 *
 * setMaxListeners stays HERE and not in run.js on purpose: it is process-wide,
 * and applying it inside the library would silently disable genuine
 * listener-leak warnings in the long-lived web server that imports run().
 */
setMaxListeners(0);

function printer(config) {
  const tallyPath = path.relative(ROOT, path.join(config.dataDir, "tally.csv"));
  return (e) => {
    switch (e.type) {
      case "run_started":
        console.log(
          `[${e.at}] campaign "${e.campaign}" — ${e.targets.length} hashtags, budget ${e.budgetMinutes} min`,
        );
        break;
      case "hashtag_done":
        console.log(
          `  ${e.platform} #${e.hashtag}: ${e.postsOnPage} on page, +${e.newCount} new, ${e.cumulative} total`,
        );
        break;
      case "hashtag_error":
        console.error(`  ${e.platform} #${e.hashtag} failed: ${e.message}`);
        break;
      case "danger":
        console.error(`  DANGER: ${e.message} — aborting the whole run (no retry).`);
        break;
      case "waiting":
        console.log(`  … waiting ${e.seconds}s before next hashtag`);
        break;
      case "budget_reached":
        console.warn(`  run budget reached — stopping after ${e.completed} hashtags`);
        break;
      case "connect_retry":
        console.warn(
          `  connect attempt ${e.attempt}/${e.retries} failed (${e.message}); retrying in ${e.retryDelayMs}ms ...`,
        );
        break;
      case "run_finished":
        console.log(
          e.status === "aborted"
            ? `[${e.at}] run ABORTED on a danger signal. Do NOT re-run today — open the app manually, clear it, resume tomorrow. See ANTIBAN.md.`
            : `[${e.at}] run complete. Tally: ${tallyPath}`,
        );
        break;
      default:
        break;
    }
  };
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const mode = args.find((a) => a.startsWith("--") && !["--business"].includes(a)) ?? "--run";
const business = flag("--business");

if (mode === "--list") {
  const all = listBusinesses();
  if (all.length === 0) {
    console.log("No businesses defined. Add one in businesses/<slug>.json or via the web app.");
  } else {
    console.log(`${all.length} business(es):`);
    for (const b of all) {
      console.log(`  ${b.slug.padEnd(28)} ${b.name}  (${b.hashtags.length} hashtags)`);
    }
  }
} else if (mode === "--check") {
  (async () => {
    const config = loadConfig({ business });
    console.log(`connecting to ${config.mcpEndpoint} ...`);
    const { toolCount, tools } = await check({ config });
    console.log(`connected — ${toolCount} tools available:`);
    console.log(tools.map((t) => `  ${t}`).join("\n"));
  })().catch((err) => {
    console.error(`connection failed: ${err.message}`);
    console.error(
      "Is Chrome running with the mcp-chrome extension connected (Service Running · Port 12306)?",
    );
    process.exit(1);
  });
} else {
  (async () => {
    const config = loadConfig({ business });
    await run({ config, onEvent: printer(config), source: "cli" });
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
