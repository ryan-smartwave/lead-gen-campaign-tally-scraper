// Hashtags mentioned in a post's own text, beyond the one that was searched.
// Pure text work — the caption is already stored, so this costs no requests.

const TAG_RE = /#([\p{L}\p{N}_]+)/gu;

/**
 * Every distinct hashtag in `text` (lowercased, in order of first appearance,
 * "#" stripped), minus the searched hashtag itself.
 */
export function extractOtherHashtags(text, exclude) {
  if (typeof text !== "string" || !text) return [];
  const ex = (exclude ?? "").toLowerCase();
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[1].toLowerCase();
    if (tag === ex || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}
