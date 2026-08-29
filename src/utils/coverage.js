/**
 * Whether one run can visit everything a campaign tracks.
 *
 * `maxHashtagsPerRun` is a safety cap, so a campaign tracking more hashtags
 * than that is not an error — runs rotate through the least recently scraped —
 * but it must never be silent: the rotation leaves per-day gaps in each
 * hashtag's series, and an operator reading the charts deserves to know why.
 */
export function coverageCheck(hashtagCount, maxPerRun) {
  if (hashtagCount > maxPerRun) {
    return {
      state: "warn",
      detail:
        `${hashtagCount} hashtags configured but at most ${maxPerRun} are scraped per run — ` +
        `each run picks the least recently scraped first, so every hashtag is covered ` +
        `on rotation but its daily series will have gaps`,
    };
  }
  return {
    state: "ok",
    detail: `all ${hashtagCount} hashtag${hashtagCount === 1 ? "" : "s"} fit in one run`,
  };
}
