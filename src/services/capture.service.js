// Instagram enrichment. The pure functions (normalizeCaptured, mergeRecords) are
// unit-tested; the *_STRING scripts run in the tab via evalJs and are exercised
// end-to-end only against a live page.

const shortcodeOf = (id) => (typeof id === "string" ? id.split("/").pop() : null);

// Recursively find every object that looks like an IG media node. Inline Relay
// payloads (ScheduledServerJS → StreamCache → __bbox → result → data → items)
// bury media ~14 levels down, so the runaway guard must sit well above that.
function* walkMedia(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 40) return;
  const m = node.media ?? node;
  if (m && typeof m === "object" && (m.code || m.shortcode)) yield m;
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    if (v && typeof v === "object") yield* walkMedia(v, depth + 1);
  }
}

function fieldFrom(m) {
  const code = m.code ?? m.shortcode;
  if (!code) return null;
  const img = m.image_versions2?.candidates?.[0]?.url
    ?? m.display_url
    ?? m.thumbnail_src
    ?? null;
  const num = (v) => (typeof v === "number" ? v : null);
  return {
    id: `ig:p/${code}`,
    url: null,
    imageUrl: img,
    caption: (typeof m.caption === "object" ? m.caption?.text : m.caption) ?? null,
    username: m.user?.username ?? m.owner?.username ?? null,
    likeCount: num(m.like_count),
    commentCount: num(m.comment_count),
    takenAt: num(m.taken_at) ?? m.taken_at_timestamp ?? null,
  };
}

export function normalizeCaptured(raw) {
  const blobs = [...(raw?.responses ?? []), ...(raw?.inline ?? [])];
  const byCode = new Map();
  for (const blob of blobs) {
    for (const m of walkMedia(blob)) {
      const rec = fieldFrom(m);
      if (!rec) continue;
      const code = shortcodeOf(rec.id);
      // A later, richer sighting overrides an earlier sparse one.
      const prev = byCode.get(code);
      byCode.set(code, prev ? { ...prev, ...clean(rec) } : rec);
    }
  }
  return [...byCode.values()];
}

// Drop null fields so a sparse later record doesn't wipe an earlier value.
function clean(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) if (v != null) out[k] = v;
  return out;
}

// The URLs Meta actually serves post data from. `/api/graphql` is the main
// channel on both platforms (Instagram since hashtag pages became
// keyword-search pages; Facebook's comet search results); the others cover IG
// post pages and older layouts.
const META_API_URL =
  /instagram\.com\/(api\/graphql|graphql\/query|api\/v1\/(tags|feed|media|fbsearch)\/)|facebook\.com\/api\/graphql/;

/**
 * Parse a chrome_network_capture stop payload (needResponseBody: true) into
 * JSON blobs for normalizeCaptured. Meta frames some responses with a
 * `for (;;);` prefix and/or newline-delimited JSON chunks, and the debugger
 * backend may hand bodies back base64-encoded.
 */
export function blobsFromNetworkCapture(payload) {
  const requests = Array.isArray(payload?.requests) ? payload.requests : [];
  const blobs = [];
  for (const r of requests) {
    if (!META_API_URL.test(r?.url ?? "")) continue;
    let text = r.responseBody;
    if (typeof text !== "string" || !text) continue;
    if (r.base64Encoded) {
      try {
        text = Buffer.from(text, "base64").toString("utf8");
      } catch {
        continue;
      }
    }
    for (const chunk of text.replace(/^for\s*\(;;\);/, "").split(/\r?\n/)) {
      try {
        blobs.push(JSON.parse(chunk));
      } catch {
        /* not JSON (HTML error page, fragment) — skip */
      }
    }
  }
  return blobs;
}

/**
 * Stable image URL Instagram serves as a 302 to the post's current signed CDN
 * asset. Derivable from the shortcode alone, and unlike captured fbcdn URLs it
 * never expires — signed CDN URLs go dead within weeks, which matters for a
 * months-long campaign archive.
 */
export function igMediaUrl(id) {
  const code = shortcodeOf(id);
  return code ? `https://www.instagram.com/p/${code}/media/?size=l` : null;
}

// Field precedence on both platforms: captured GraphQL > React-prop read
// (prop* fields the in-page extractor lifted off the card's fiber — passive,
// best-effort) > DOM > derived fallback.
export function mergeRecords(domPosts, capturedPosts) {
  const capByCode = new Map(capturedPosts.map((c) => [shortcodeOf(c.id), c]));
  return domPosts.map((d) => {
    const c = capByCode.get(shortcodeOf(d.id)) ?? {};
    return {
      id: d.id,                                   // DOM id is canonical (knows reel vs post)
      url: d.url ?? null,                          // DOM wins for url
      imageUrl: c.imageUrl ?? d.imageUrl ?? decodeImageUrl(d.propImage) ?? igMediaUrl(d.id),
      caption: c.caption ?? d.propCaption ?? d.preview ?? null,
      username: c.username ?? d.propUsername ?? null,
      likeCount: c.likeCount ?? d.propLikeCount ?? null,
      commentCount: c.commentCount ?? d.propCommentCount ?? null,
      takenAt: c.takenAt ?? d.propTakenAt ?? null,
      platform: "instagram",
    };
  });
}

// --- in-page scripts (strings run via evalJs) ---

// Serves BOTH platforms: the keep() filter matches the relative /api/graphql
// path Facebook's comet search fetches use as well as Instagram's endpoints.
export const IG_CAPTURE_INSTALL = `
if (!window.__swCapture) {
  window.__swCapture = [];
  var MAX = 150, cap = window.__swCapture;
  var keep = function(url, text){
    if (!/\\/api\\/graphql|\\/graphql\\/query|\\/api\\/v1\\/(tags|feed|media|fbsearch)\\//.test(url)) return;
    if (!text || text.length > 2000000) return;
    cap.push(text);
    while (cap.length > MAX) cap.shift();
  };
  var of = window.fetch;
  window.fetch = function(){
    var args = arguments;
    return of.apply(this, args).then(function(res){
      try { var u = (args[0] && args[0].url) || args[0] || '';
        res.clone().text().then(function(t){ try { keep(String(u), t); } catch(e){} }); } catch(e){}
      return res;
    });
  };
  var oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u){ this.__swUrl = u; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(){
    var xhr = this;
    xhr.addEventListener('load', function(){ try { keep(String(xhr.__swUrl||''), xhr.responseText); } catch(e){} });
    return oSend.apply(this, arguments);
  };
}
return true;
`;

// The harvest MUST run in-page and return compact records: mcp-chrome truncates
// large tool results (a 485KB inline Relay blob comes back gutted to ~7KB), so
// shipping raw responses to Node can never work. Its sanitizer also redacts any
// URL carrying a query string; Instagram CDN image URLs need their signature
// params, so those are base64-tagged in-page — host-whitelisted to Instagram's
// own CDNs — and decoded by decodeCandidateUrls() on the way out.
const IG_WALK_FNS = `
var IMG_OK = /^https:\\/\\/[^/]+\\.(fbcdn\\.net|cdninstagram\\.com)\\//;
var enc = function(u){ return (u && IMG_OK.test(u)) ? ('b64:' + btoa(u)) : null; };
var looksLikeMedia = function(m){
  return m.like_count != null || m.taken_at != null || m.taken_at_timestamp != null ||
    m.image_versions2 || m.display_url || m.thumbnail_src ||
    m.caption !== undefined || m.user || m.owner || m.pk != null || m.media_type != null;
};
var walk = function(node, depth, out){
  if (!node || typeof node !== 'object' || depth > 40) return;
  var m = node.media || node;
  if (m && typeof m === 'object' && (m.code || m.shortcode) && looksLikeMedia(m)) {
    var img = null;
    try {
      img = (m.image_versions2 && m.image_versions2.candidates && m.image_versions2.candidates[0]
              && m.image_versions2.candidates[0].url) || m.display_url || m.thumbnail_src || null;
    } catch(e){}
    out.push({
      code: m.code || m.shortcode,
      like_count: typeof m.like_count === 'number' ? m.like_count : null,
      comment_count: typeof m.comment_count === 'number' ? m.comment_count : null,
      taken_at: typeof m.taken_at === 'number' ? m.taken_at :
        (typeof m.taken_at_timestamp === 'number' ? m.taken_at_timestamp : null),
      caption: (m.caption && typeof m.caption === 'object') ? { text: m.caption.text || null } :
        (typeof m.caption === 'string' ? { text: m.caption } : null),
      user: { username: (m.user && m.user.username) || (m.owner && m.owner.username) || null },
      image_versions2: { candidates: [{ url: enc(img) }] }
    });
  }
  var vals = Array.isArray(node) ? node : Object.values(node);
  for (var i = 0; i < vals.length; i++) {
    if (vals[i] && typeof vals[i] === 'object') walk(vals[i], depth + 1, out);
  }
};
`;

// Dedup/merge `found` into `records`. Capped: mcp-chrome truncates large tool
// results wholesale, and a truncated JSON payload parses to nothing — a bounded
// slice loses the tail but keeps everything before it intact.
const IG_MERGE_SNIPPET = `
var byCode = {};
found.forEach(function(r){
  var prev = byCode[r.code];
  if (!prev) { byCode[r.code] = r; return; }
  ['like_count', 'comment_count', 'taken_at'].forEach(function(k){
    if (prev[k] == null && r[k] != null) prev[k] = r[k];
  });
  if ((!prev.caption || !prev.caption.text) && r.caption && r.caption.text) prev.caption = r.caption;
  if (!prev.user.username && r.user.username) prev.user = r.user;
  if (!prev.image_versions2.candidates[0].url && r.image_versions2.candidates[0].url) {
    prev.image_versions2 = r.image_versions2;
  }
});
var records = Object.keys(byCode).map(function(k){ return byCode[k]; }).slice(0, 300);
`;

// Both capture sources: the fetch/XHR ring buffer and the JSON inlined in the page.
const IG_WALK_SNIPPET = `
${IG_WALK_FNS}
var found = [];
(window.__swCapture || []).forEach(function(t){ try { walk(JSON.parse(t), 0, found); } catch(e){} });
document.querySelectorAll('script[type="application/json"]').forEach(function(s){
  try { walk(JSON.parse(s.textContent), 0, found); } catch(e){}
});
${IG_MERGE_SNIPPET}
`;

export const IG_CAPTURE_HARVEST = `
${IG_WALK_SNIPPET}
return { records: records };
`;

/**
 * Incremental drain for deep scrolls: harvest ONLY the fetch/XHR ring buffer,
 * then empty it. A 20+ minute scroll produces far more API responses than any
 * buffer can hold and far more records than one bridge-safe payload can carry,
 * so the caller drains every few scroll steps and accumulates in Node. Skips
 * the inline <script> JSON — that never changes after load, and the final
 * IG_CAPTURE_HARVEST (which still runs) walks it exactly once.
 */
export const IG_CAPTURE_DRAIN = `
${IG_WALK_FNS}
var found = [];
var buf = window.__swCapture || [];
for (var i = 0; i < buf.length; i++) { try { walk(JSON.parse(buf[i]), 0, found); } catch(e){} }
buf.length = 0;
${IG_MERGE_SNIPPET}
return { records: records };
`;

export const IG_POST_EXTRACT = `
if (/\\/accounts\\/login/.test(location.href)) return { loggedOut: true };
${IG_WALK_SNIPPET}
var og = function(p){ var el = document.querySelector('meta[property="'+p+'"]'); return el ? el.content : null; };
return { loggedOut: false, records: records,
  ogImage: enc(og('og:image')), ogTitle: og('og:title') };
`;

/**
 * Undo the in-page base64 tagging of Instagram CDN image URLs (see
 * IG_WALK_SNIPPET). Values that are not tagged, fail to decode, don't pass the
 * host whitelist, or were redacted by the bridge become null.
 */
const IMG_HOST_OK = /^https:\/\/[^/]+\.(fbcdn\.net|cdninstagram\.com)\//;
export function decodeImageUrl(value) {
  if (typeof value !== "string" || !value) return null;
  if (!value.startsWith("b64:")) return IMG_HOST_OK.test(value) ? value : null;
  try {
    const url = Buffer.from(value.slice(4), "base64").toString("utf8");
    return IMG_HOST_OK.test(url) ? url : null;
  } catch {
    return null;
  }
}

/** Decode the tagged image url inside each compact in-page record, in place-ish. */
export function decodeCandidateUrls(records) {
  if (!Array.isArray(records)) return [];
  return records.map((r) => {
    const url = decodeImageUrl(r?.image_versions2?.candidates?.[0]?.url);
    return { ...r, image_versions2: { candidates: [{ url }] } };
  });
}

/* ---------------- Facebook ----------------

   Facebook search cards expose no usable post URL in the DOM: real permalinks
   are only written into hrefs on hover (an interaction we never perform), and
   the bridge redacts what is there. Captions are visually truncated at
   "See more" — another click we never perform. Both problems have the same
   passive answer as Instagram's: the page ALREADY receives every search
   result as GraphQL JSON carrying the full message text, the canonical
   permalink (wwwURL), the actor, reaction/comment counts, an image URI and
   creation_time. Reading those responses adds zero requests and zero
   interactions; the observable behavior of a run is unchanged. */

// A story node is any object carrying a numeric-string post_id. Yields nested
// (shared) stories too; the per-story field pick below refuses to cross into a
// DIFFERENT post's subtree so fields don't bleed between outer and inner post.
export function* walkStories(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 48) return;
  if (typeof node.post_id === "string" && /^\d+$/.test(node.post_id)) yield node;
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    if (v && typeof v === "object") yield* walkStories(v, depth + 1);
  }
}

const FB_URL_OK = /^https:\/\/(www|web|m)\.facebook\.com\//;

/** Like decodeImageUrl, but whitelisting Facebook permalink hosts. */
export function decodeFbUrl(value) {
  if (typeof value !== "string" || !value) return null;
  if (!value.startsWith("b64:")) return FB_URL_OK.test(value) ? value : null;
  try {
    const url = Buffer.from(value.slice(4), "base64").toString("utf8");
    return FB_URL_OK.test(url) ? url : null;
  } catch {
    return null;
  }
}

// Field paths vary by comet build, so this picks defensively from the story's
// subtree rather than hardcoding one shape. Handles raw GraphQL nodes and the
// compact in-page drain records alike (the drain emits mini story nodes with
// the same key names, with URL values b64-tagged past the bridge's redaction).
function fbFieldFrom(story) {
  const rec = {
    post_id: story.post_id,
    url: null,
    caption: null,
    username: null,
    imageUrl: null,
    likeCount: null,
    commentCount: null,
    takenAt: null,
  };
  const w = (n, d) => {
    if (!n || typeof n !== "object" || d > 25) return;
    // A nested story with a different post_id is a shared/inner post: stop.
    if (n !== story && typeof n.post_id === "string" && n.post_id !== story.post_id) return;
    if (rec.caption == null && typeof n.message?.text === "string" && n.message.text) {
      rec.caption = n.message.text;
    }
    if (rec.url == null) {
      const u = typeof n.wwwURL === "string" ? n.wwwURL
        : typeof n.permalink_url === "string" ? n.permalink_url : null;
      if (u) rec.url = decodeFbUrl(u);
    }
    if (rec.username == null && typeof n.actors?.[0]?.name === "string") {
      rec.username = n.actors[0].name;
    }
    if (rec.imageUrl == null) {
      const img = typeof n.photo_image?.uri === "string" ? n.photo_image.uri
        : typeof n.media?.image?.uri === "string" ? n.media.image.uri : null;
      if (img) rec.imageUrl = decodeImageUrl(img);
    }
    if (rec.likeCount == null && typeof n.reaction_count?.count === "number") {
      rec.likeCount = n.reaction_count.count;
    }
    if (rec.commentCount == null && typeof n.comments?.total_count === "number") {
      rec.commentCount = n.comments.total_count;
    }
    if (rec.takenAt == null && typeof n.creation_time === "number") {
      rec.takenAt = n.creation_time;
    }
    for (const v of Array.isArray(n) ? n : Object.values(n)) {
      if (v && typeof v === "object") w(v, d + 1);
    }
  };
  w(story, 0);
  // No captured permalink (or the bridge redacted the b64-tagged one): a bare
  // /<post_id> URL resolves on Facebook, and a working link beats a null.
  if (rec.url == null) rec.url = `https://www.facebook.com/${story.post_id}`;
  return rec;
}

export function normalizeFbCaptured(raw) {
  const byId = new Map();
  for (const blob of raw?.responses ?? []) {
    for (const s of walkStories(blob)) {
      const rec = fbFieldFrom(s);
      const prev = byId.get(rec.post_id);
      byId.set(rec.post_id, prev ? { ...prev, ...clean(rec) } : rec);
    }
  }
  return [...byId.values()];
}

/**
 * A working permalink derived from a DOM-harvested fbid, for cards the
 * captured stories never matched. `fb:id<fbid>` ids come from photo links'
 * fbid params (facebook.com/photo/?fbid= resolves them); `fb:ida.<id>` came
 * from a `set` param, which is an album (media/set). Content-hash ids
 * (`fb:c…`) carry no id Facebook can resolve — those stay null.
 */
export function fbUrlFromPostId(postId) {
  if (typeof postId !== "string" || !postId.startsWith("fb:id")) return null;
  const id = postId.slice(5);
  if (!id) return null;
  return id.startsWith("a.")
    ? `https://www.facebook.com/media/set/?set=${id}`
    : `https://www.facebook.com/photo/?fbid=${id}`;
}

/**
 * Author text b64-tagged in-page (the bridge's sanitizer redacts bare
 * name-like strings — live data showed 106/106 authors arriving as
 * "<redacted>" — but passes base64). UTF-8-safe on the way back.
 */
export function decodeFbText(value) {
  if (typeof value !== "string" || !value) return null;
  if (value === "<redacted>") return null;
  if (!value.startsWith("b64:")) return value;
  try {
    return Buffer.from(value.slice(4), "base64").toString("utf8") || null;
  } catch {
    return null;
  }
}

/**
 * The page/person name a Facebook search card's innerText leads with:
 * "Host Jasmine · Follow · …", "Concept A is in Tagaytay. · …". Fallback for
 * cards whose author link text didn't survive, and for backfilling old rows.
 * Album/shared cards don't lead with the author, so they return null rather
 * than a wrong name.
 */
export function fbNameFromCardText(text) {
  if (typeof text !== "string" || !text) return null;
  let t = text.replace(/^(?:Online status indicator(?: Active)?\s*)+/i, "").trim();
  if (/^Album\b/i.test(t)) {
    // Album shares lead with the album title; the poster's name follows the
    // avatar's "Online status indicator" marker. No marker → no safe guess.
    const after = t.match(/Online status indicator(?: Active)?\s+(.*)$/i);
    if (!after) return null;
    t = after[1].trim();
  }
  if (!t) return null;
  const m = t.match(/^(.{2,80}?)(?:\s*·|\s+is (?:with|at|in)\b|\s+(?:added|updated|shared|posted|was live|feeling)\b)/);
  const name = m?.[1]?.trim() ?? null;
  return name && name.length >= 2 ? name : null;
}

const normText = (s) => (s ?? "").toLowerCase().replace(/\d+/g, "").replace(/\s+/g, " ").trim();

/**
 * Attach captured story fields to the DOM cards. DOM ids stay canonical (the
 * content fingerprint the campaign's dedup memory is keyed by — switching to
 * post_ids would recount every post once), so matching is by text: a card's
 * innerText contains the start of its post's message, even when the display
 * truncates at "See more". Digits are stripped on both sides because
 * engagement counts and "5 mins ago" timestamps drift between the two reads.
 * An unmatched card stays DOM-only — counted, just not enriched.
 */
export function mergeFbRecords(domPosts, capturedStories) {
  const pool = capturedStories.filter((c) => normText(c.caption).length >= 12);
  const used = new Set();
  return domPosts.map((d) => {
    const dText = normText(d.text);
    let hit = null;
    for (const c of pool) {
      if (used.has(c)) continue;
      // 24 normalized chars: long enough to be distinctive, short enough to
      // fit inside even an aggressively truncated "See more" preview.
      if (dText.includes(normText(c.caption).slice(0, 24))) {
        hit = c;
        used.add(c);
        break;
      }
    }
    // prop* fields are consumed here and stripped — they must not leak into
    // the stored record shape.
    const { propUrl, propUsername, propCaption, propImage, propTakenAt,
            propLikeCount, propCommentCount, ...rest } = d;
    return {
      ...rest,
      platform: "facebook",
      author: decodeFbText(d.author) ?? fbNameFromCardText(d.text),
      url: hit?.url ?? d.url ?? decodeFbUrl(propUrl) ?? fbUrlFromPostId(d.id),
      caption: hit?.caption ?? propCaption ?? null, // full message — past "See more"
      username: hit?.username ?? propUsername ?? null,
      imageUrl: hit?.imageUrl ?? d.imageUrl ?? decodeImageUrl(propImage),
      likeCount: hit?.likeCount ?? propLikeCount ?? null,
      commentCount: hit?.commentCount ?? propCommentCount ?? null,
      takenAt: hit?.takenAt ?? propTakenAt ?? null,
    };
  });
}

// --- Facebook in-page scripts (strings run via evalJs) ---

// Same design constraints as the IG snippets (see the note above IG_WALK_FNS):
// compact records only, URLs b64-tagged past the bridge's query-string
// redaction, bounded output. The pick mirrors fbFieldFrom.
const FB_WALK_FNS = `
var IMG_OK = /^https:\\/\\/[^/]+\\.(fbcdn\\.net|cdninstagram\\.com)\\//;
var FB_OK = /^https:\\/\\/(www|web|m)\\.facebook\\.com\\//;
var encImg = function(u){ return (u && IMG_OK.test(u)) ? ('b64:' + btoa(u)) : null; };
var encUrl = function(u){ try { return (u && FB_OK.test(u)) ? ('b64:' + btoa(u)) : null; } catch(e){ return null; } };
var pick = function(story){
  var rec = { post_id: story.post_id, message: null, actors: null, wwwURL: null,
              photo_image: null, reaction_count: null, comments: null, creation_time: null };
  var w = function(n, d){
    if (!n || typeof n !== 'object' || d > 25) return;
    if (n !== story && typeof n.post_id === 'string' && n.post_id !== story.post_id) return;
    if (!rec.message && n.message && typeof n.message.text === 'string' && n.message.text) {
      rec.message = { text: n.message.text.slice(0, 2000) };
    }
    if (!rec.wwwURL && typeof n.wwwURL === 'string') rec.wwwURL = encUrl(n.wwwURL);
    if (!rec.wwwURL && typeof n.permalink_url === 'string') rec.wwwURL = encUrl(n.permalink_url);
    if (!rec.actors && n.actors && n.actors[0] && typeof n.actors[0].name === 'string') {
      rec.actors = [{ name: n.actors[0].name }];
    }
    if (!rec.photo_image && n.photo_image && typeof n.photo_image.uri === 'string') {
      rec.photo_image = { uri: encImg(n.photo_image.uri) };
    }
    if (!rec.photo_image && n.media && n.media.image && typeof n.media.image.uri === 'string') {
      rec.photo_image = { uri: encImg(n.media.image.uri) };
    }
    if (rec.reaction_count == null && n.reaction_count && typeof n.reaction_count.count === 'number') {
      rec.reaction_count = { count: n.reaction_count.count };
    }
    if (rec.comments == null && n.comments && typeof n.comments.total_count === 'number') {
      rec.comments = { total_count: n.comments.total_count };
    }
    if (rec.creation_time == null && typeof n.creation_time === 'number') rec.creation_time = n.creation_time;
    var vals = Array.isArray(n) ? n : Object.values(n);
    for (var i = 0; i < vals.length; i++) if (vals[i] && typeof vals[i] === 'object') w(vals[i], d + 1);
  };
  w(story, 0);
  return rec;
};
var walk = function(node, depth, out){
  if (!node || typeof node !== 'object' || depth > 48) return;
  if (typeof node.post_id === 'string' && /^[0-9]+$/.test(node.post_id)) out.push(pick(node));
  var vals = Array.isArray(node) ? node : Object.values(node);
  for (var i = 0; i < vals.length; i++) if (vals[i] && typeof vals[i] === 'object') walk(vals[i], depth + 1, out);
};
`;

const FB_MERGE_SNIPPET = `
var byId = {};
found.forEach(function(r){
  var prev = byId[r.post_id];
  if (!prev) { byId[r.post_id] = r; return; }
  ['message', 'actors', 'wwwURL', 'photo_image', 'reaction_count', 'comments'].forEach(function(k){
    if (prev[k] == null && r[k] != null) prev[k] = r[k];
  });
  if (prev.creation_time == null && r.creation_time != null) prev.creation_time = r.creation_time;
});
var records = Object.keys(byId).map(function(k){ return byId[k]; }).slice(0, 300);
`;

// Facebook inlines its first page of results in the same ScheduledServerJS
// script tags Instagram uses (both are Meta comet apps), so the full harvest
// walks those too; the drain walks only the fetch/XHR buffer, then empties it.
export const FB_CAPTURE_HARVEST = `
${FB_WALK_FNS}
var found = [];
(window.__swCapture || []).forEach(function(t){ try { walk(JSON.parse(t), 0, found); } catch(e){} });
document.querySelectorAll('script[type="application/json"]').forEach(function(s){
  try { walk(JSON.parse(s.textContent), 0, found); } catch(e){}
});
${FB_MERGE_SNIPPET}
return { records: records };
`;

export const FB_CAPTURE_DRAIN = `
${FB_WALK_FNS}
var found = [];
var buf = window.__swCapture || [];
for (var i = 0; i < buf.length; i++) { try { walk(JSON.parse(buf[i]), 0, found); } catch(e){} }
buf.length = 0;
${FB_MERGE_SNIPPET}
return { records: records };
`;
