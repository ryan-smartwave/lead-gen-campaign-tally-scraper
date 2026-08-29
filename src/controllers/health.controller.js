import { loadGlobal, listCampaigns } from "../config/index.js";
import { isDbConfigured } from "../db/pool.js";
import { isRunning } from "../services/supervisor.service.js";
import { campaignDay } from "../utils/day.js";

/** Liveness plus enough context to diagnose a misconfigured install. */
export async function getHealth(_req, res) {
  let mcpEndpoint = null;
  let configError = null;
  try {
    mcpEndpoint = loadGlobal().mcpEndpoint;
  } catch (err) {
    configError = err.message;
  }

  res.json({
    ok: true,
    service: "lead-gen-campaign-tally-scraper",
    campaignDay: campaignDay(),
    database: isDbConfigured() ? "configured" : "missing",
    running: isRunning(),
    campaigns: listCampaigns().length,
    mcpEndpoint,
    configError,
  });
}
