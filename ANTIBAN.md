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
6. **Randomized order and timing.** Hashtags are shuffled each run, and you should not fire the run at the exact same clock minute daily.
7. **Abort on the first danger sign — never retry.** If a run hits a login wall, a checkpoint/challenge, a "we restrict certain activity" / "try again later" notice, or a suspended-account page, the tool **stops the entire run immediately** and records it. Blocks escalate: retrying through a checkpoint turns a few-hour speed bump into a 7–14 day restriction. A missed day is cheap; an escalated block is not.
8. **Daily only, never continuous.** One short run per day. No polling loops, no background hammering.
9. **Resilient tally.** The per-hashtag counts are cumulative and persisted, so a skipped or aborted day never corrupts the campaign series — the next run just picks up.

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
