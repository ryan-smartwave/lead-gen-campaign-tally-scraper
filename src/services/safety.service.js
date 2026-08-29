import { evalJs, callTool, sleep } from "./mcp.service.js";

export const rand = (min, max) => min + Math.random() * (max - min);
export const randInt = (min, max) => Math.floor(rand(min, max + 1));

// Random delay from a [min, max] ms pair (as configured).
export const jitter = ([min, max]) => sleep(rand(min, max));

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// A raised BlockError aborts the whole run — callers must not retry.
// Carries the reason/url structurally as well as in the message, so consumers
// (the web UI) can branch on a code instead of parsing prose.
export class BlockError extends Error {
  constructor(message, { reason, url } = {}) {
    super(message);
    this.name = "BlockError";
    this.reason = reason;
    this.url = url;
  }
}

// Detects login walls, checkpoints, and soft rate-limit notices from the live page.
const DANGER_PROBE = `
const url = location.href;
const body = (document.body ? document.body.innerText : '').toLowerCase().slice(0, 5000);
const hit = (re) => re.test(url) || re.test(body);
let reason = null;
if (/\\/accounts\\/login|\\/login\\b|\\/login\\.php/.test(url)) reason = 'login_wall';
else if (/\\/challenge|checkpoint|\\/suspended|\\/disabled|\\/authentication/.test(url)) reason = 'checkpoint';
else if (body.includes('try again later')) reason = 'try_again_later';
else if (body.includes('we restrict certain activity')) reason = 'activity_restricted';
else if (body.includes('temporarily blocked') || body.includes('action blocked')) reason = 'action_blocked';
else if (body.includes("couldn't refresh feed") || body.includes('couldnt refresh feed')) reason = 'feed_refuse';
else if (body.includes('your account has been disabled')) reason = 'account_disabled';
return { url, reason };
`;

// Throws BlockError if the current page shows any danger sign. Call after each navigation.
export async function assertSafe(client, context) {
  const { url, reason } = await evalJs(client, DANGER_PROBE);
  if (reason) {
    throw new BlockError(`${reason} at ${url} (during ${context})`, { reason, url });
  }
  return url;
}

// Human-like incremental scrolling: partial-viewport steps with randomized pauses,
// instead of jumping to the bottom (which is an obvious bot signature).
//
// Two budgets: `steps` (fixed count) or `minutes` as a [min, max] pair — a
// duration sampled once per call, so no two hashtags ever scroll for the same
// length of time. When `restEveryMs`/`restPauseMs` pairs are given, the loop
// takes randomized multi-second "reading breaks": nobody flicks a feed at a
// steady 3–9s cadence for 20 minutes straight, so an unbroken deep scroll is
// itself a fixed-rhythm signature.
//
// `onStep` (optional) runs after each pause — feeds virtualize their DOM,
// pruning rows scrolled past, so a caller that only reads at the end loses most
// of what scrolled by. Reading per step is a DOM read, not a network request.
// Returning `false` from onStep ends the scroll early (feed exhausted, target
// reached); anything it throws (e.g. a BlockError from a danger probe)
// propagates and aborts the scroll immediately.
export async function humanScroll(
  client,
  { steps, minutes, scrollPauseMs, restEveryMs, restPauseMs },
  journal,
  onStep,
) {
  const budgetMs = Array.isArray(minutes) ? rand(minutes[0], minutes[1]) * 60_000 : null;
  const startedAt = Date.now();
  if (budgetMs != null) {
    journal?.log?.("scroll_budget", { detail: { minutes: Math.round(budgetMs / 6000) / 10 } });
  }
  const resting = Array.isArray(restEveryMs) && Array.isArray(restPauseMs);
  let nextRestAt = resting ? startedAt + rand(restEveryMs[0], restEveryMs[1]) : Infinity;
  const more = (i) => (budgetMs != null ? Date.now() - startedAt < budgetMs : i < steps);
  for (let i = 0; more(i); i++) {
    await evalJs(
      client,
      "window.scrollBy(0, Math.round(window.innerHeight * (0.7 + Math.random() * 0.4))); return true;",
    ).catch(() => {});
    journal?.log?.("scroll", { detail: { step: i + 1 } });
    await jitter(scrollPauseMs);
    if (Date.now() >= nextRestAt) {
      const restMs = rand(restPauseMs[0], restPauseMs[1]);
      journal?.log?.("rest", { detail: { ms: Math.round(restMs) } });
      await sleep(restMs);
      nextRestAt = Date.now() + rand(restEveryMs[0], restEveryMs[1]);
    }
    if (onStep && (await onStep(i)) === false) break;
  }
}

export async function navigate(client, url) {
  await callTool(client, "chrome_navigate", { url });
}
