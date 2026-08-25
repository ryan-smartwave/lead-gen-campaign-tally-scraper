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
6. **Randomized order.** Hashtags are shuffled each run, so the visit sequence never repeats. Runs are started manually, so start times vary naturally; if you ever wire up a scheduler, vary the trigger time yourself rather than firing at the same clock minute daily. When a business tracks more hashtags than the per-run cap, the run rotates through the least recently scraped first, so the extra hashtags are still covered without raising the per-run volume.
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
