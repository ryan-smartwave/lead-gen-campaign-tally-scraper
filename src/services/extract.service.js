// In-page extraction scripts, executed in the tab via chrome_javascript.
// Each returns { loggedOut: boolean, posts: [...] }. Running in-page avoids the
// Readability processing that chrome_get_web_content applies, and dodges output-size
// limits by shipping only the extracted records rather than the whole DOM.

export const IG_EXTRACT = `
if (/\\/accounts\\/login/.test(location.href)) return { loggedOut: true, posts: [] };
const seen = {}, out = [];
document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').forEach(a => {
  const href = a.getAttribute('href') || '';
  const m = href.match(/\\/(p|reel)\\/([A-Za-z0-9_-]+)/);
  if (!m) return;
  const id = 'ig:' + m[1] + '/' + m[2];
  if (seen[id]) return; seen[id] = 1;
  const img = a.querySelector('img');
  out.push({
    platform: 'instagram', id,
    url: new URL(href, location.origin).href.split('?')[0],
    preview: img ? img.getAttribute('alt') : null
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
  out.push({ platform: 'facebook', id: id, author: author, text: raw.slice(0, 400) });
});
return { loggedOut: false, posts: out };
`;

