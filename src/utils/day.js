/**
 * The campaign day boundary, defined once.
 *
 * A run's ISO timestamp is UTC, so deriving a date from it would put anything
 * before 08:00 local time on the previous day — silently breaking the once-a-day
 * guard and every daily chart. Asia/Manila is UTC+8 with no daylight saving, so
 * this is about as low-risk as timezone code gets.
 *
 * Nothing else in the codebase may slice a date out of a timestamp.
 */

export const CAMPAIGN_TZ = process.env.CAMPAIGN_TZ ?? "Asia/Manila";

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: CAMPAIGN_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Campaign day as YYYY-MM-DD. */
export function campaignDay(when = new Date()) {
  const d = typeof when === "string" ? new Date(when) : when;
  const p = Object.fromEntries(PARTS.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
