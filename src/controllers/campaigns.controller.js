import {
  listCampaigns,
  writeCampaign,
  deleteCampaign,
  slugify,
} from "../config/index.js";
import { refreshCampaignMirror } from "../services/supervisor.service.js";
import { ApiError } from "../utils/ApiError.js";

/**
 * Campaigns and their hashtag lists.
 *
 * Writes go to this repo's own files, which keeps the CLI and the UI reading the
 * same definitions with no second source of truth. Safety limits are absent on
 * purpose: hashtags are content, safety is the anti-ban firewall, and no route
 * may widen it.
 */

export async function list(_req, res) {
  res.json({ campaigns: listCampaigns() });
}

export async function create(req, res) {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) throw new ApiError(400, "invalid", "Give the campaign a name.");

  const slug = req.body?.slug || slugify(name);
  if (!slug) {
    throw new ApiError(
      400,
      "invalid",
      "That name has no letters or digits to build an id from — try another.",
    );
  }
  if (!req.body?.slug && listCampaigns().some((b) => b.slug === slug)) {
    throw new ApiError(409, "exists", `A campaign with the id "${slug}" already exists.`);
  }

  try {
    const campaign = writeCampaign({
      slug,
      name,
      hashtags: req.body?.hashtags ?? [],
      campaignStart: req.body?.campaignStart,
      campaignEnd: req.body?.campaignEnd,
    });
    await refreshCampaignMirror().catch(() => {});
    res.json({ campaign });
  } catch (err) {
    throw new ApiError(400, "invalid", err.message);
  }
}

export async function update(req, res) {
  const { slug } = req.params;
  const existing = listCampaigns().find((b) => b.slug === slug);
  if (!existing) throw new ApiError(404, "not_found", `No campaign with the id "${slug}".`);

  const name =
    typeof req.body?.name === "string" && req.body.name.trim()
      ? req.body.name.trim()
      : existing.name;
  const hashtags = Array.isArray(req.body?.hashtags) ? req.body.hashtags : existing.hashtags;

  try {
    const campaign = writeCampaign({
      slug,
      name,
      hashtags,
      campaignStart: req.body?.campaignStart,
      campaignEnd: req.body?.campaignEnd,
    });
    await refreshCampaignMirror().catch(() => {});
    res.json({ campaign });
  } catch (err) {
    throw new ApiError(400, "invalid", err.message);
  }
}

/**
 * Removes the definition only. Collected results stay in the database, so
 * re-creating the campaign with the same id picks its history back up.
 */
export async function remove(req, res) {
  const { slug } = req.params;
  if (!listCampaigns().some((b) => b.slug === slug)) {
    throw new ApiError(404, "not_found", `No campaign with the id "${slug}".`);
  }
  deleteCampaign(slug);
  await refreshCampaignMirror().catch(() => {});
  res.json({
    deleted: slug,
    note: "Collected results were left in place; re-creating this campaign with the same id restores its history.",
  });
}
