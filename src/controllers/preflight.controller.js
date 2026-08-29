import { loadGlobal, listCampaigns } from "../config/index.js";
import { isDbConfigured } from "../db/pool.js";
import { isRunning, ranToday } from "../services/supervisor.service.js";
import { probeMcp } from "../services/mcpProbe.service.js";
import { BUSY_HINT } from "../services/mcp.service.js";
import { campaignDay } from "../utils/day.js";
import { coverageCheck } from "../utils/coverage.js";

/**
 * Everything a client needs to decide whether a run can start, and to explain
 * why not.
 *
 * Deliberately cheap: a localhost TCP probe and a couple of local lookups. It
 * never contacts Instagram or Facebook — verifying those sessions costs real
 * page visits, so it stays a separate, explicit action.
 *
 * Always answers 200. This endpoint reports failures; it does not fail.
 */
export async function getPreflight(req, res) {
  const all = listCampaigns();
  const requested = req.query.campaign;
  const campaign = all.find((b) => b.slug === requested) ?? all[0] ?? null;

  let global;
  try {
    global = loadGlobal();
  } catch (err) {
    return res.json({
      canRun: false,
      blockedBy: "config_invalid",
      campaignDay: campaignDay(),
      campaign: null,
      campaigns: all.map((b) => ({ slug: b.slug, name: b.name, hashtags: b.hashtags.length })),
      checks: { config: { state: "fail", detail: err.message } },
    });
  }

  const mcp = await probeMcp(global.mcpEndpoint);
  const already = campaign ? await ranToday(campaign.slug) : false;
  const running = isRunning();

  // Ordered by what the operator should fix first.
  const blockedBy = !campaign
    ? "no_campaign"
    : campaign.hashtags.length === 0
      ? "no_hashtags"
      : !isDbConfigured()
        ? "db_not_configured"
        : running
          ? "already_running"
          : !mcp.reachable
            ? "mcp_unreachable"
            : already
              ? "already_ran_today"
              : null;

  res.json({
    canRun: blockedBy === null,
    blockedBy,
    // Only the once-a-day guard may be overridden, and only deliberately.
    overridable: blockedBy === "already_ran_today",
    campaignDay: campaignDay(),
    campaign: campaign
      ? { slug: campaign.slug, name: campaign.name, hashtags: campaign.hashtags }
      : null,
    campaigns: all.map((b) => ({ slug: b.slug, name: b.name, hashtags: b.hashtags.length })),
    checks: {
      mcp: {
        state: mcp.reachable ? "ok" : "fail",
        detail: mcp.detail,
        hint: mcp.reachable ? null : BUSY_HINT,
      },
      database: {
        state: isDbConfigured() ? "ok" : "fail",
        detail: isDbConfigured()
          ? "connection string present"
          : "DATABASE_URL is not set in the scraper's .env",
      },
      today: {
        state: already ? "warn" : "ok",
        detail: already
          ? `already ran today (${campaignDay()})`
          : `no run yet today (${campaignDay()})`,
      },
      // Not a blocker — runs rotate through the excess — but never silent:
      // the rotation leaves per-day gaps in each hashtag's series.
      coverage: coverageCheck(campaign?.hashtags.length ?? 0, global.safety.maxHashtagsPerRun),
      sessions: {
        state: "not_checked",
        detail:
          "Checking this visits Instagram and Facebook for real, so it is never done automatically.",
      },
    },
    safety: global.safety,
  });
}
