// In-page extraction scripts, executed in the tab via chrome_javascript.
// Each returns { loggedOut: boolean, posts: [...] }. Running in-page avoids the
// Readability processing that chrome_get_web_content applies, and dodges output-size
// limits by shipping only the extracted records rather than the whole DOM.

// React-fiber fallback, shared by both extractors. The data a card renders
// from (the same GraphQL story/media objects the network capture sees) hangs
// off its DOM nodes as __reactFiber$*/__reactProps$* — what DevTools' Inspect →
// Properties shows. Reading it is purely passive: no events, no requests,
// nothing observable to the page. Best-effort by design: fiber internals are
// undocumented and change with Meta's builds, so every read is bounded
// (node + depth caps) and failure just means the field stays null.
const FIBER_FNS = `
var fiberOf = function(el){
  try { for (var k in el) { if (k.indexOf('__reactFiber$') === 0) return el[k]; } } catch(e){}
  return null;
};
// The data-bearing props live on composite ANCESTORS of the host node (the
// element's own fiber subtree carries only DOM props), so walk the return
// chain upward. Verified live 2026-08-27: downward walks find nothing.
// visit() returning true stops the walk — used to stop at the first fiber
// that yielded fields, before reaching list-level components whose props
// carry OTHER posts' stories.
var walkFiberUp = function(el, boundEl, visit, maxUp){
  var f = fiberOf(el), n = 0;
  while (f && n < maxUp) {
    var sn = f.stateNode;
    // A host ancestor rendering outside the card means we've left this
    // post's own component tree.
    if (sn && sn.nodeType === 1 && sn !== el && boundEl && !boundEl.contains(sn)) return;
    try {
      if (f.memoizedProps && typeof f.memoizedProps === 'object' && visit(f.memoizedProps)) return;
    } catch(e){}
    f = f.return; n++;
  }
};
`;

// Grid thumbnails live on Instagram's CDN with signed query strings; the bridge
// redacts URLs carrying query strings, so they are base64-tagged here and
// decoded by capture.service's decodeImageUrl on the way out.
export const IG_EXTRACT = `
if (/\\/accounts\\/login/.test(location.href)) return { loggedOut: true, posts: [] };
${FIBER_FNS}
const IMG_OK = /^https:\\/\\/[^/]+\\.(fbcdn\\.net|cdninstagram\\.com)\\//;
const seen = {}, out = [];
var fiberBudget = 8000; // page-wide cap: props are insurance, never worth stalling extraction
document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').forEach(a => {
  const href = a.getAttribute('href') || '';
  const m = href.match(/\\/(p|reel)\\/([A-Za-z0-9_-]+)/);
  if (!m) return;
  const id = 'ig:' + m[1] + '/' + m[2];
  if (seen[id]) return; seen[id] = 1;
  const img = a.querySelector('img');
  // Fiber fallback: an ancestor's props carry this card's media object (the
  // keyword-search grid wraps it as {code, username, mediaRef, ...}). Trust an
  // object only if its shortcode matches this card, harvest the FIRST match,
  // and stop the walk there — list-level ancestors hold every post on the
  // page, and re-scanning them per card is what makes a page-wide walk slow.
  var pr = { user: null, cap: null, t: null, lk: null, cm: null };
  if (fiberBudget > 0) {
    var done = false;
    // The try/catch is load-bearing: props can hold cross-origin Window refs
    // whose every property access throws a SecurityError — one uncaught throw
    // silently aborts the whole card's scan (found live 2026-08-27).
    var scan = function(o, d){
      if (done || !o || typeof o !== 'object' || d > 8) return;
      try {
        if ((o.code === m[2] || o.shortcode === m[2])) {
          // Old API shape nests user/owner; the keyword-search grid's Relay
          // wrapper exposes a flat camelCase username (verified live).
          pr.user = (o.user && o.user.username) || (o.owner && o.owner.username) ||
            (typeof o.username === 'string' && o.username ? o.username : null);
          pr.cap = (o.caption && typeof o.caption === 'object' && o.caption.text) ||
            (typeof o.caption === 'string' ? o.caption : null);
          pr.t = typeof o.taken_at === 'number' ? o.taken_at :
            (typeof o.taken_at_timestamp === 'number' ? o.taken_at_timestamp : null);
          pr.lk = typeof o.like_count === 'number' ? o.like_count : null;
          pr.cm = typeof o.comment_count === 'number' ? o.comment_count : null;
          done = true;
          return;
        }
        var vals = Array.isArray(o) ? o : Object.values(o);
        for (var i = 0; i < vals.length && !done; i++) {
          if (vals[i] && typeof vals[i] === 'object') scan(vals[i], d + 1);
        }
      } catch(e){}
    };
    var used = 0;
    walkFiberUp(a, null, function(p){
      used++;
      scan(p, 0);
      return done;
    }, 30);
    fiberBudget -= Math.max(used, 1);
  }
  out.push({
    platform: 'instagram', id,
    url: new URL(href, location.origin).href.split('?')[0],
    preview: img ? img.getAttribute('alt') : null,
    imageUrl: img && IMG_OK.test(img.src || '') ? 'b64:' + btoa(img.src) : null,
    propUsername: pr.user, propCaption: pr.cap, propTakenAt: pr.t,
    propLikeCount: pr.lk, propCommentCount: pr.cm
  });
});
return { loggedOut: false, posts: out };
`;

// Facebook renders hashtag/search results as a [role=feed] of post cards, and mcp-chrome
// redacts the post URLs (query values / base64 paths). So we identify posts by CONTENT,
// not URL: fingerprint author + caption text (which are not redacted and are stable across
// days), stripping digits so changing engagement/time counts don't drift the id. When a
// post exposes a real photo/set fbid, prefer that as the id.
export const FB_EXTRACT = `
if (/\\/login|checkpoint|\\/authentication|\\/recover/.test(location.href)) return { loggedOut: true, posts: [] };
function hh(s){var x=2166136261>>>0;for(var i=0;i<s.length;i++){x^=s.charCodeAt(i);x=Math.imul(x,16777619)>>>0;}return ('0000000'+x.toString(16)).slice(-8);}
var feed = document.querySelector('[role="feed"]');
if (!feed) return { loggedOut: false, posts: [] };
// The bridge's sanitizer redacts bare name-like strings (every author of the
// first 106 recorded posts arrived as "<redacted>"), so the author text ships
// base64-tagged — UTF-8-safe — and capture.service's decodeFbText unwraps it.
var encName = function(s){
  try { return 'b64:' + btoa(unescape(encodeURIComponent(s))); } catch(e){ return null; }
};
var seen = {}, out = [];
Array.prototype.forEach.call(feed.children, function(card){
  var raw = (card.innerText || '').replace(/(?:\\bFacebook\\b\\s*)+/g, ' ').replace(/\\s+/g, ' ').trim();
  if (raw.length < 15) return;                 // skip dividers / empty chrome
  var author = null;
  var links = card.querySelectorAll('a[href*="__cft__"]');
  for (var i = 0; i < links.length; i++) {
    var t = (links[i].textContent || '').trim();
    if (t && t.length > 1 && t !== 'Facebook') { author = t; break; }
  }
  var fbid = null;
  Array.prototype.forEach.call(card.querySelectorAll('a[href]'), function(a){
    if (fbid) return;
    try { var u = new URL(a.getAttribute('href'), location.origin);
      var f = u.searchParams.get('fbid') || u.searchParams.get('set');
      if (f) fbid = f;
    } catch (e) {}
  });
  var basis = (author || '') + '|' + raw.replace(/[0-9]/g, '').slice(0, 160);
  var id = 'fb:' + (fbid ? 'id' + fbid : 'c' + hh(basis));
  if (seen[id]) return; seen[id] = 1;
  // First sizeable CDN image = the post's content image; tiny ones are avatars
  // and reaction glyphs. b64-tagged past the bridge's query-string redaction.
  var img = null;
  Array.prototype.forEach.call(card.querySelectorAll('img'), function(im){
    if (img) return;
    var src = im.src || '';
    if (!/^https:\\/\\/[^/]+\\.fbcdn\\.net\\//.test(src)) return;
    if ((im.width || 0) < 120 || (im.height || 0) < 120) return;
    try { img = 'b64:' + btoa(src); } catch (e) {}
  });
  // No fiber fallback here, deliberately: Facebook's own React build does not
  // expose __reactFiber$ on DOM nodes (probed live 2026-08-27 — cards carry
  // only opaque __reactHandles$ objects with no enumerable internals), so the
  // card's story props are unreachable in-page. FB rich fields come from the
  // GraphQL capture, and links otherwise from fbUrlFromPostId; mergeFbRecords
  // still honors prop* fields should a future FB build expose fibers.
  out.push({ platform: 'facebook', id: id, author: author ? encName(author) : null,
    text: raw.slice(0, 400), imageUrl: img });
});
return { loggedOut: false, posts: out };
`;

