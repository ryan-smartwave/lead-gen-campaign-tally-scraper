// Instagram enrichment. The pure functions (normalizeCaptured, mergeRecords) are
// unit-tested; the *_STRING scripts run in the tab via evalJs and are exercised
// end-to-end only against a live page.

const shortcodeOf = (id) => (typeof id === "string" ? id.split("/").pop() : null);

// Recursively find every object that looks like an IG media node.
function* walkMedia(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return;
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

export function mergeRecords(domPosts, capturedPosts) {
  const capByCode = new Map(capturedPosts.map((c) => [shortcodeOf(c.id), c]));
  return domPosts.map((d) => {
    const c = capByCode.get(shortcodeOf(d.id));
    if (!c) return {
      id: d.id, url: d.url ?? null, imageUrl: null,
      caption: d.preview ?? null, username: null,
      likeCount: null, commentCount: null, takenAt: null, platform: "instagram",
    };
    return {
      id: d.id,                                   // DOM id is canonical (knows reel vs post)
      url: d.url ?? null,                          // DOM wins for url
      imageUrl: c.imageUrl ?? null,
      caption: c.caption ?? d.preview ?? null,
      username: c.username ?? null,
      likeCount: c.likeCount ?? null,             // captured wins
      commentCount: c.commentCount ?? null,
      takenAt: c.takenAt ?? null,
      platform: "instagram",
    };
  });
}

// --- in-page scripts (strings run via evalJs) ---

export const IG_CAPTURE_INSTALL = `
if (!window.__swCapture) {
  window.__swCapture = [];
  var MAX = 50, cap = window.__swCapture;
  var keep = function(url, text){
    if (!/\\/api\\/v1\\/tags\\/|\\/graphql\\/query|\\/api\\/v1\\/feed\\//.test(url)) return;
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

export const IG_CAPTURE_HARVEST = `
var responses = [];
(window.__swCapture || []).forEach(function(t){ try { responses.push(JSON.parse(t)); } catch(e){} });
var inline = [];
document.querySelectorAll('script[type="application/json"]').forEach(function(s){
  try { inline.push(JSON.parse(s.textContent)); } catch(e){}
});
return { responses: responses, inline: inline };
`;

export const IG_POST_EXTRACT = `
if (/\\/accounts\\/login/.test(location.href)) return { loggedOut: true };
var responses = [];
(window.__swCapture || []).forEach(function(t){ try { responses.push(JSON.parse(t)); } catch(e){} });
var inline = [];
document.querySelectorAll('script[type="application/json"]').forEach(function(s){
  try { inline.push(JSON.parse(s.textContent)); } catch(e){}
});
var og = function(p){ var el = document.querySelector('meta[property="'+p+'"]'); return el ? el.content : null; };
return { loggedOut: false, responses: responses, inline: inline,
  ogImage: og('og:image'), ogTitle: og('og:title') };
`;
