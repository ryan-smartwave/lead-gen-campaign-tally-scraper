# Not getting banned — the design basis

This tool's first requirement is **survive a ~4-month daily campaign without the account getting flagged or banned.** Everything else (the hashtag tally) is built on top of these rules. This note is the reasoning; the code implements it.

## Why our posture is already the safe one

Most "how to scrape Instagram" advice is about *faking* legitimacy — residential proxies, rotated TLS fingerprints, warmed-up API sessions — because those tools drive headless browsers or raw HTTP from datacenters, which Meta bans on sight. We don't fake anything:

| Common ban trigger | Typical scraper | This tool |
|---|---|---|
| Datacenter IP (banned instantly) | Needs residential proxies | **Your real home/office IP** |
| Detectable automation fingerprint (headless, Python TLS) | Needs fingerprint rotation | **Your real Chrome**, real cookies, real fingerprint |
| Fake/simulated login | High risk | **You are already logged in manually** |
| Engagement automation (like/follow/DM) — *the #1 action-block cause* | The whole point of those tools | **Read-only. Never likes, follows, comments, or DMs.** |
| High volume (200 req/hr IP cap) | Pushes the limit | **A few hashtags, once a day, a few scrolls each** — orders of magnitude under any limit |

Passive reading of a few hashtag feeds, from a real logged-in browser on a residential IP, at human pace, once a day, is close to the lowest-risk automated activity possible on the platform. The research consistently puts bans on **behavioral signatures and engagement actions**, not on quietly viewing public hashtag pages.

## The rules the tool enforces

1. **Read-only, always.** The tool navigates, scrolls, and reads the DOM. It performs zero engagement actions. This alone avoids the dominant ban cause (action blocks from auto-like/follow/DM).
2. **One dedicated, aged account.** Use a real account that has existed and been used normally for a while — not a fresh one (fresh accounts doing anything unusual are the first flagged). Don't use a personal/primary account: the research notes 5–15% session loss per week even when doing everything right, so use one you can afford to lose.
3. **One machine, one IP, one session.** Don't log this account in on other devices/IPs at the same time — "logins from multiple devices/IPs in a short window" is an explicit flag. Keep it on this Chrome profile.
4. **Low, bounded volume.** Hard caps: max hashtags per run, max scrolls per hashtag, and a max total run duration. A daily run touches a handful of pages, nowhere near the ~200-requests/hour IP ceiling.
5. **Human pace, randomized — never a fixed rhythm.** Fixed intervals are themselves a bot signature. The tool jitters every delay: incremental scrolls (not jump-to-bottom) with random pauses, and a randomized long gap between each hashtag (minutes, not seconds). This is what naturally stretches a run to the 30–60 min window.
6. **Randomized order.** Hashtags are shuffled each run, so the visit sequence never repeats. Runs are started manually, so start times vary naturally; if you ever wire up a scheduler, vary the trigger time yourself rather than firing at the same clock minute daily. When a campaign tracks more hashtags than the per-run cap, the run rotates through the least recently scraped first, so the extra hashtags are still covered without raising the per-run volume.
7. **Abort on the first danger sign — never retry.** If a run hits a login wall, a checkpoint/challenge, a "we restrict certain activity" / "try again later" notice, or a suspended-account page, the tool **stops the entire run immediately** and records it. Blocks escalate: retrying through a checkpoint turns a few-hour speed bump into a 7–14 day restriction. A missed day is cheap; an escalated block is not.
8. **Daily only, never continuous.** One short run per day. No polling loops, no background hammering.
9. **Resilient tally.** The per-hashtag counts are cumulative and persisted, so a skipped or aborted day never corrupts the campaign series — the next run just picks up.

## Throughput and enrichment — safe by design

**Tab pipelining is safe.** A run uses one and only one active tab at all times.
During the mandatory idle gap between hashtags (3–7 minutes, randomized), that one
tab is pre-navigated to the *next* hashtag's URL while the account waits. When the
gap ends, scrolling starts immediately instead of waiting for navigation. This saves
time, not risk: activity is still strictly sequential (one scroll, one navigation, one
tab), and the fixed, multi-minute gap is preserved — behavior stays human-like and
cannot produce a parallel-scraping signature. If the tab-navigation capability becomes
unavailable, the tool degrades to plain sequential visits (no preload) automatically.

**Deep scroll mode — going past a handful of scrolls, without changing the posture.**
When `safety.scrollMinutesPerHashtag` is set (a `[min, max]` pair, hard-capped at 45),
each hashtag scrolls for a randomized time budget instead of a fixed step count. This
exists because ~5 scrolls yields under 100 posts, and campaign tallies may need
hundreds-to-thousands per hashtag. The rules that make it as safe as a long scroll can be:

- **The pace never changes.** Steps and pauses are identical to short mode (partial
  viewport, 3–9 s jitter). Depth comes from duration, not speed — the request *rate*
  stays where it was; only the session length grows.
- **Reading breaks.** Every ~2.5–5 minutes (randomized) the scroll pauses for a
  randomized 15–45 s "reading" rest. An unbroken 25-minute flick at a metronomic
  3–9 s cadence is itself a rhythm signature; humans stop and read.
- **Stop at the known frontier.** The collector loads the campaign's already-recorded
  post ids for the hashtag before scrolling. After `dryStopAfterScrolls` consecutive
  steps (default 10) that surface zero posts *new to the campaign* — not merely new to
  this run — the hashtag ends early. This is what makes a months-long campaign cheap:
  day 1 spends the full budget backfilling, but day 30's feed is mostly posts already
  archived, so the scroll ends within minutes of passing yesterday's frontier. Requests
  are spent only where unknown posts are; re-scrolling captured history is risk with
  zero data gain. (The threshold is consecutive steps, not first overlap, because the
  feed interleaves popular older posts among recent ones.)
- **Per-hashtag ceiling.** `maxPostsPerHashtag` (default 3000) ends the hashtag once
  the target is met, so a single viral tag can't eat the whole run's request budget.
- **Danger checks mid-scroll, not just at the ends.** The login-wall/checkpoint/
  "try again later" probe runs every ~10 steps; a soft block 4 minutes into a
  25-minute scroll aborts the run then, per §7.
- **Fewer hashtags per run, same daily coverage.** Deep runs should lower
  `maxHashtagsPerRun` (default config now pairs 20–28 min scrolls with 6 tags and a
  210-minute run budget); the least-recently-visited rotation (§6) still covers a
  larger hashtag list across days. Total daily volume is the number that matters.

**What deep mode does NOT promise:** 10,000 posts per hashtag per day is not safely
reachable. At human pace the feed paginates roughly 12–24 posts per fetch every few
steps, so a 20–28 minute scroll realistically surfaces ~500–2,000 posts per hashtag —
and Instagram often stops serving new results well before that. Reaching for more
means faster scrolling (a rate signature) or longer/parallel sessions (a volume
signature); both are exactly what gets accounts flagged. If the campaign needs more
volume, add *days*, not speed.

**Passive network capture adds no requests — on both platforms.** Rich fields
(username, full caption, like/reaction and comment counts, image, posted-at,
and on Facebook the real permalink) are read from the responses the page was
already going to receive (via the extension's debugger capture, started before
navigation) and from JSON already embedded in the page. Nothing is re-fetched,
replayed or requested twice; the observable network behavior of a run is
identical with capture on or off.

**Facebook's DOM gaps are closed passively, never by interacting.** Facebook
search cards expose no post URL in the DOM (real permalinks are only written
into hrefs on hover) and truncate captions at "See more". Both a hover and a
"See more" click are interactions an automated session should not perform —
hundreds of expand-clicks per run is exactly the kind of scripted interaction
pattern behavioral detection looks for. Instead, the permalink (`wwwURL`) and
the full untruncated message text are taken from the GraphQL search responses
the page already received. Zero clicks, zero hovers, zero extra requests.

**Platform alternation: better spacing AND a shorter run.** Visit order
interleaves the two platforms (IG, FB, IG, FB…). Facebook cannot observe an
Instagram scroll and vice versa, so while one platform is being scrolled the
other is resting — each platform sees ~15–25 minutes between its own visits,
far more than any gap provided. That earned rest is why a platform *switch*
takes only a short randomized breather (`crossPlatformGapMs`, 1–2.5 min) while
consecutive same-platform visits keep the full `gapBetweenHashtagsMs`
(3–7 min). Enrichment post-visits likewise pace on their own
`postVisitGapMs` (45–120 s): a human clicking through a few posts does not
freeze for five minutes between them, and the old behavior of reusing the
hashtag gap there was borrowed pacing, not safety. None of this changes scroll
speed, rests, request counts, or the one-active-tab rule.

**React-prop reads are passive; Facebook's date filter is just a URL.** Two later
additions, both inside the existing posture. (1) On Instagram, each grid card's
React fiber props are read in-page as a fallback for fields capture missed
(currently the poster's username) — a bounded, read-only walk of JS objects the
page already holds: no events, no requests, nothing observable. Facebook gets no
such read because its React build exposes no fiber internals on DOM nodes
(probed live 2026-08-27). (2) When a campaign has campaign dates, the Facebook
search URL carries FB's own `rp_creation_time` filter (the same one its UI's
"Date posted" emits), so results are pre-narrowed to the campaign window. This
*reduces* wasted requests — the same single navigation, fewer scrolls burned on
years-old posts. Instagram's search has no date facility; its window filtering
stays post-hoc on `taken_at`.

**Rich post enrichment is capped and careful.** When hashtag scrolling captures posts
missing key fields (username, caption, posted-at timestamp — common on initial load),
a capped post-visit phase enriches them by visiting individual post pages. The budget
is strict: at most `safety.maxPostVisitsPerRun` visits per run (default 8), distributed
across the enrichment queue, human-paced with the same random dwell times and multi-minute
gaps as the main loop. If a post page hits a danger sign (login wall, checkpoint, etc.),
the entire enrichment phase stops immediately and never retries — keeping with §7 (abort
on the first danger sign). Unenriched posts are still counted in the tally (unknown age
or missing fields do not make them invalid).

**Forensics always on.** Every run writes an action journal to `data/journal/<runId>.jsonl`,
one line per navigation, scroll, dwell, gap, enrichment visit, and danger event, timestamped
and sequenced. The journal is retained for 30 days and pruned automatically. On any danger
sign, an incident bundle is written to `data/incidents/<runId>/` — `incident.json` with
the reason, URL, and context; best-effort `page.txt` (extracted DOM) and `screenshot.png`;
plus a cumulative `data/incidents/index.log` for quick review. The tool itself is designed
to avoid flags, but the journal and incidents exist to *detect and diagnose* any that occur
— a complete forensic trail of what the account did, when, and what the platform responded with.

**Same-account parallel scraping was rejected.** A design considered concurrent scraping
on the same account via multiple tabs (trading safety for speed) — e.g., two hashtags
scrolling at once. This was rejected explicitly: multiple concurrent navigations and scrolls
from the same IP/account in a short window is a textbook bot signature, and the research notes
it as a primary flag trigger. The tool is sequential by choice.

## If something does go wrong

- **Login wall / checkpoint appears:** stop using the tool that day. Open Instagram/Facebook manually in that Chrome profile, clear the checkpoint like a normal human, use the app normally for a bit, and resume the tool the next day.
- **A hashtag returns nothing but others work:** likely a restricted/"banned" hashtag on the platform's side (a data gap, not an account problem). Recorded as `empty`, run continues.
- **Repeated empties or slowdowns:** treat as a soft rate-limit signal — pause the tool for a day or two, keep the account's manual use normal.

## Sources

- [How to Scrape Instagram in 2026 — Scrapfly](https://scrapfly.io/blog/posts/how-to-scrape-instagram)
- [Scrape Instagram Without Getting Blocked — HikerAPI](https://hikerapi.com/help/instagram-scraping-without-getting-blocked)
- [Instagram Automated Behaviour: What's Banned vs. Safe — Spur](https://www.spurnow.com/en/blogs/instagram-automated-behaviour)
- [Instagram Action Block: What It Is & Why It Happens (2026) — FANS](https://fans.walter-labs.com/blog/instagram-action-block/)
- [How to Fix Instagram Action Block in 2026 — Proxidize](https://proxidize.com/blog/instagram-action-block/)
