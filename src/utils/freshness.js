// Campaign-window freshness. Pure: no I/O, so both stores share one rule and it
// cannot drift between file and database modes.

// Accepts ISO string, epoch seconds, epoch ms, or Date. Returns a Date or null.
// Heuristic for numbers: < 1e12 is treated as seconds (ms since 1970 crossed 1e12
// in 2001, so any real post time in ms is well above it).
function toDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export function parseWindow({ campaignStart, campaignEnd } = {}) {
  return { start: toDate(campaignStart), end: toDate(campaignEnd) };
}

export function isFresh(takenAt, window = { start: null, end: null }) {
  const d = toDate(takenAt);
  if (!d) return true; // unknown age counts — never shrink counts silently
  if (window.start && d < window.start) return false;
  if (window.end && d > window.end) return false;
  return true;
}

export function countFresh(posts, window) {
  let n = 0;
  for (const p of posts) if (isFresh(p?.takenAt, window)) n += 1;
  return n;
}
