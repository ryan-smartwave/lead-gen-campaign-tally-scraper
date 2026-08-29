import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCaptured,
  mergeRecords,
  blobsFromNetworkCapture,
  decodeImageUrl,
  decodeCandidateUrls,
} from "../src/services/capture.service.js";

const TAG_RESPONSE = {
  data: { recent: { sections: [{ layout_content: { medias: [
    { media: {
      code: "ABC123",
      like_count: 55, comment_count: 4, taken_at: 1754006400,
      user: { username: "acme_co" },
      caption: { text: "join our #campaign" },
      image_versions2: { candidates: [{ url: "https://img/1.jpg" }] },
    }},
  ]}}] } },
};

test("normalizeCaptured pulls fields from a tag response", () => {
  const recs = normalizeCaptured({ responses: [TAG_RESPONSE], inline: [] });
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.id, "ig:p/ABC123");
  assert.equal(r.username, "acme_co");
  assert.equal(r.likeCount, 55);
  assert.equal(r.commentCount, 4);
  assert.equal(r.caption, "join our #campaign");
  assert.equal(r.imageUrl, "https://img/1.jpg");
  assert.equal(r.takenAt, 1754006400);
});

test("normalizeCaptured tolerates junk and missing fields", () => {
  assert.deepEqual(normalizeCaptured({ responses: [null, 5, { nope: true }], inline: [] }), []);
  const recs = normalizeCaptured({ responses: [{ data: { recent: { sections: [
    { layout_content: { medias: [{ media: { code: "X" } }] } },
  ]}}}], inline: [] });
  assert.equal(recs[0].id, "ig:p/X");
  assert.equal(recs[0].likeCount, null);
});

// Real IG pages ship inline data through Relay's ScheduledServerJS/StreamCache
// wrapper, which buries the media node ~14 object levels down — far past any
// shallow recursion cutoff.
const RELAY_INLINE = {
  require: [[
    "ScheduledServerJS", "handle", null,
    [{ __bbox: { require: [[
      "RelayPrefetchedStreamCache", "next", [],
      ["adp_PolarisPostRootQuery", { __bbox: { complete: true, result: { data: {
        xdt_api__v1__media__shortcode__web_info: { items: [
          { code: "DEEP42", like_count: 9, comment_count: 2, taken_at: 1754006400,
            user: { username: "deep_user" }, caption: { text: "buried treasure" } },
        ] },
      } } } }],
    ]] } }],
  ]],
};

test("normalizeCaptured finds media buried in Relay inline payloads", () => {
  const recs = normalizeCaptured({ responses: [], inline: [RELAY_INLINE] });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].id, "ig:p/DEEP42");
  assert.equal(recs[0].username, "deep_user");
  assert.equal(recs[0].likeCount, 9);
  assert.equal(recs[0].caption, "buried treasure");
});

test("blobsFromNetworkCapture keeps only IG API bodies and parses Meta's framing", () => {
  const payload = {
    requests: [
      // the real data channel since IG moved hashtag pages to keyword search
      { url: "https://www.instagram.com/api/graphql", responseBody: 'for (;;);{"a":1}\n{"b":2}' },
      { url: "https://www.instagram.com/graphql/query", responseBody: '{"c":3}' },
      // base64-encoded body
      {
        url: "https://www.instagram.com/api/v1/media/123/info/",
        responseBody: Buffer.from('{"d":4}').toString("base64"),
        base64Encoded: true,
      },
      // non-API traffic and junk must be dropped, never throw
      { url: "https://static.cdninstagram.com/btmanifest/x", responseBody: '{"e":5}' },
      { url: "https://graph.instagram.com/logging_client_events", responseBody: "{}" },
      { url: "https://www.instagram.com/api/graphql", responseBody: "<!doctype html>not json" },
      { url: "https://www.instagram.com/api/graphql" }, // no body at all
    ],
  };
  const blobs = blobsFromNetworkCapture(payload);
  assert.deepEqual(blobs, [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }]);
});

const b64 = (s) => "b64:" + Buffer.from(s).toString("base64");

test("decodeImageUrl untags CDN urls and rejects everything else", () => {
  const cdn = "https://scontent.cdninstagram.com/v/t51/1_n.jpg?stp=dst&oh=abc&oe=123";
  assert.equal(decodeImageUrl(b64(cdn)), cdn);
  assert.equal(decodeImageUrl(cdn), cdn); // already-plain CDN url passes through
  assert.equal(decodeImageUrl(b64("https://evil.example.com/x.jpg")), null); // host whitelist
  assert.equal(decodeImageUrl("[BLOCKED: Cookie/query string data]"), null); // bridge redaction
  assert.equal(decodeImageUrl("b64:!!!not-base64"), null);
  assert.equal(decodeImageUrl(null), null);
});

test("decodeCandidateUrls decodes each compact record's image slot", () => {
  const cdn = "https://ig.fmnl13-1.fna.fbcdn.net/v/a.jpg?oh=x&oe=y";
  const out = decodeCandidateUrls([
    { code: "A", image_versions2: { candidates: [{ url: b64(cdn) }] } },
    { code: "B", image_versions2: { candidates: [{ url: null }] } },
  ]);
  assert.equal(out[0].image_versions2.candidates[0].url, cdn);
  assert.equal(out[1].image_versions2.candidates[0].url, null);
  assert.deepEqual(decodeCandidateUrls(undefined), []);
});

test("normalizeCaptured maps compact in-page records like any media node", () => {
  const minis = [{
    code: "CPT1", like_count: 12, comment_count: 1, taken_at: 1754006400,
    caption: { text: "hi" }, user: { username: "acme" },
    image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/v/1.jpg?oh=a&oe=b" }] },
  }];
  const recs = normalizeCaptured({ responses: [minis], inline: [] });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].id, "ig:p/CPT1");
  assert.equal(recs[0].likeCount, 12);
  assert.equal(recs[0].username, "acme");
  assert.equal(recs[0].caption, "hi");
  assert.equal(recs[0].imageUrl, "https://scontent.cdninstagram.com/v/1.jpg?oh=a&oe=b");
});

test("blobsFromNetworkCapture tolerates a missing or malformed payload", () => {
  assert.deepEqual(blobsFromNetworkCapture(null), []);
  assert.deepEqual(blobsFromNetworkCapture({}), []);
  assert.deepEqual(blobsFromNetworkCapture({ requests: "nope" }), []);
});

test("mergeRecords matches on shortcode and keeps DOM id + url", () => {
  const dom = [{ id: "ig:reel/ABC123", url: "https://www.instagram.com/reel/ABC123/", preview: "alt" }];
  const captured = [{ id: "ig:p/ABC123", likeCount: 55, username: "acme_co", takenAt: 1754006400, imageUrl: "https://img/1.jpg", caption: "c" }];
  const merged = mergeRecords(dom, captured);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "ig:reel/ABC123");           // DOM id canonical
  assert.equal(merged[0].url, "https://www.instagram.com/reel/ABC123/");
  assert.equal(merged[0].likeCount, 55);                    // captured fills in
  assert.equal(merged[0].username, "acme_co");
});

test("mergeRecords keeps DOM-only posts the capture missed", () => {
  const dom = [{ id: "ig:p/ONLY", url: "u", preview: "alt" }];
  const merged = mergeRecords(dom, []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "ig:p/ONLY");
  assert.equal(merged[0].likeCount, null);
  // No captured or DOM image → the durable /media/ redirect derived from the id.
  assert.equal(merged[0].imageUrl, "https://www.instagram.com/p/ONLY/media/?size=l");
});

test("mergeRecords falls back to the grid thumbnail when capture has no image", () => {
  const dom = [
    { id: "ig:p/A", url: "u", preview: "alt", imageUrl: "https://cdn/thumb-a.jpg" },
    { id: "ig:p/B", url: "u", preview: "alt", imageUrl: "https://cdn/thumb-b.jpg" },
  ];
  const captured = [{ id: "ig:p/A", imageUrl: "https://cdn/full-a.jpg" }];
  const merged = mergeRecords(dom, captured);
  assert.equal(merged[0].imageUrl, "https://cdn/full-a.jpg"); // captured wins
  assert.equal(merged[1].imageUrl, "https://cdn/thumb-b.jpg"); // DOM fallback
});

// ---------------- Facebook ----------------

test("normalizeFbCaptured pulls fields from a comet search story", async () => {
  const { normalizeFbCaptured } = await import("../src/services/capture.service.js");
  const payload = { data: { serpResponse: { results: { edges: [{ relay_rendering_strategy: { view_model: { click_model: { story: {
    __typename: "Story",
    post_id: "1234567890",
    actors: [{ name: "Acme Events", id: "111" }],
    message: { text: "Full caption text that keeps going well past where See more would cut it off #campaign" },
    wwwURL: "https://www.facebook.com/acme/posts/pfbid0abc",
    attachments: [{ styles: { attachment: { media: { photo_image: { uri: "https://scontent.fbcdn.net/v/t39/photo.jpg?stp=x&oh=1&oe=2" } } } } }],
    feedback: { reaction_count: { count: 42 }, comments: { total_count: 7 } },
    creation_time: 1754006400,
  } } } } }] } } } };
  const recs = normalizeFbCaptured({ responses: [payload] });
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.post_id, "1234567890");
  assert.equal(r.username, "Acme Events");
  assert.match(r.caption, /See more would cut it off/);
  assert.equal(r.url, "https://www.facebook.com/acme/posts/pfbid0abc");
  assert.equal(r.imageUrl, "https://scontent.fbcdn.net/v/t39/photo.jpg?stp=x&oh=1&oe=2");
  assert.equal(r.likeCount, 42);
  assert.equal(r.commentCount, 7);
  assert.equal(r.takenAt, 1754006400);
});

test("normalizeFbCaptured keeps a shared inner post's fields separate", async () => {
  const { normalizeFbCaptured } = await import("../src/services/capture.service.js");
  const payload = { story: {
    post_id: "111",
    actors: [{ name: "Sharer" }],
    // outer post has no message of its own; inner shared story has one
    attached_story: {
      post_id: "222",
      actors: [{ name: "Original Author" }],
      message: { text: "the original caption text of the shared post here" },
      feedback: { reaction_count: { count: 5 } },
    },
  } };
  const recs = normalizeFbCaptured({ responses: [payload] });
  const outer = recs.find((r) => r.post_id === "111");
  const inner = recs.find((r) => r.post_id === "222");
  assert.equal(outer.caption, null, "outer post did not steal the inner post's message");
  assert.equal(outer.username, "Sharer");
  assert.equal(inner.caption, "the original caption text of the shared post here");
  assert.equal(inner.username, "Original Author");
  assert.equal(inner.likeCount, 5);
});

test("normalizeFbCaptured decodes b64-tagged compact drain records", async () => {
  const { normalizeFbCaptured } = await import("../src/services/capture.service.js");
  const url = "https://www.facebook.com/x/posts/pfbid0zz";
  const img = "https://scontent.fbcdn.net/v/a.jpg?oh=1&oe=2";
  const minis = [{
    post_id: "555",
    message: { text: "compact record text" },
    actors: [{ name: "acme" }],
    wwwURL: "b64:" + Buffer.from(url).toString("base64"),
    photo_image: { uri: "b64:" + Buffer.from(img).toString("base64") },
    reaction_count: { count: 3 },
    comments: { total_count: 1 },
    creation_time: 1754006400,
  }];
  const recs = normalizeFbCaptured({ responses: [minis] });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].url, url);
  assert.equal(recs[0].imageUrl, img);
  assert.equal(recs[0].likeCount, 3);
});

test("decodeFbUrl whitelists facebook permalink hosts only", async () => {
  const { decodeFbUrl } = await import("../src/services/capture.service.js");
  const ok = "https://www.facebook.com/acme/posts/pfbid0abc";
  assert.equal(decodeFbUrl(ok), ok);
  assert.equal(decodeFbUrl("b64:" + Buffer.from(ok).toString("base64")), ok);
  assert.equal(decodeFbUrl("https://evil.example.com/facebook.com/x"), null);
  assert.equal(decodeFbUrl("b64:" + Buffer.from("https://evil.example.com/").toString("base64")), null);
  assert.equal(decodeFbUrl("[BLOCKED: Cookie/query string data]"), null);
  assert.equal(decodeFbUrl(null), null);
});

test("mergeFbRecords matches captured stories to DOM cards by text", async () => {
  const { mergeFbRecords } = await import("../src/services/capture.service.js");
  const dom = [
    // card innerText: author + truncated message + UI chrome, digits drift daily
    { id: "fb:c1a2b3c4", author: "Acme Events", text: "Acme Events 5h Full caption text that keeps going we... See more 42 12 comments Like Comment Share" },
    { id: "fb:cdeadbeef", author: "Nobody", text: "A card the capture never saw at all" },
  ];
  const captured = [{
    post_id: "1234567890",
    caption: "Full caption text that keeps going well past where See more would cut it off #campaign",
    username: "Acme Events",
    url: "https://www.facebook.com/acme/posts/pfbid0abc",
    imageUrl: "https://scontent.fbcdn.net/v/photo.jpg?oh=1",
    likeCount: 42, commentCount: 7, takenAt: 1754006400,
  }];
  const merged = mergeFbRecords(dom, captured);
  assert.equal(merged[0].id, "fb:c1a2b3c4", "DOM fingerprint id stays canonical");
  assert.equal(merged[0].url, "https://www.facebook.com/acme/posts/pfbid0abc");
  assert.match(merged[0].caption, /past where See more/);
  assert.equal(merged[0].username, "Acme Events");
  assert.equal(merged[0].likeCount, 42);
  assert.equal(merged[0].takenAt, 1754006400);
  // unmatched card still counts, just unenriched
  assert.equal(merged[1].id, "fb:cdeadbeef");
  assert.equal(merged[1].url, null);
  assert.equal(merged[1].likeCount, null);
});

test("blobsFromNetworkCapture also keeps Facebook graphql bodies", () => {
  const blobs = blobsFromNetworkCapture({ requests: [
    { url: "https://www.facebook.com/api/graphql/", responseBody: '{"fb":1}\n{"fb":2}' },
    { url: "https://www.facebook.com/ajax/bz", responseBody: '{"junk":1}' },
  ] });
  assert.deepEqual(blobs, [{ fb: 1 }, { fb: 2 }]);
});

test("a story without a captured permalink gets the bare post-id URL", async () => {
  const { normalizeFbCaptured } = await import("../src/services/capture.service.js");
  const recs = normalizeFbCaptured({ responses: [{ story: {
    post_id: "998877",
    message: { text: "caption without any url in the payload" },
  } }] });
  assert.equal(recs[0].url, "https://www.facebook.com/998877");
});

/* ---------------- derived FB URLs ---------------- */

test("fbUrlFromPostId derives a link from a DOM-harvested fbid", async () => {
  const { fbUrlFromPostId } = await import("../src/services/capture.service.js");
  assert.equal(
    fbUrlFromPostId("fb:id1682260960575974"),
    "https://www.facebook.com/photo/?fbid=1682260960575974",
  );
});

test("fbUrlFromPostId derives an album link from a set id", async () => {
  const { fbUrlFromPostId } = await import("../src/services/capture.service.js");
  assert.equal(
    fbUrlFromPostId("fb:ida.1428320932661125"),
    "https://www.facebook.com/media/set/?set=a.1428320932661125",
  );
});

test("fbUrlFromPostId returns null for content-hash ids", async () => {
  const { fbUrlFromPostId } = await import("../src/services/capture.service.js");
  assert.equal(fbUrlFromPostId("fb:cd5f87966"), null);
  assert.equal(fbUrlFromPostId("ig:p/ABC"), null);
  assert.equal(fbUrlFromPostId(null), null);
});

test("mergeFbRecords falls back to a derived fbid URL for unmatched cards", async () => {
  const { mergeFbRecords } = await import("../src/services/capture.service.js");
  const dom = [{ platform: "facebook", id: "fb:id123456", text: "no captured story for this" }];
  const merged = mergeFbRecords(dom, []);
  assert.equal(merged[0].url, "https://www.facebook.com/photo/?fbid=123456");
});

/* ---------------- React-props fallback ---------------- */


test("mergeFbRecords uses React-prop fields when no captured story matches", async () => {
  const { mergeFbRecords } = await import("../src/services/capture.service.js");
  const dom = [{
    platform: "facebook",
    id: "fb:cabc12345",
    text: "player chrome only",
    propUrl: b64("https://www.facebook.com/reel/987"),
    propUsername: "Host Jasmine",
    propCaption: "full untruncated message #tag",
    propImage: b64("https://scontent.fbcdn.net/v/img.jpg?sig=1"),
    propTakenAt: 1756100000,
  }];
  const [m] = mergeFbRecords(dom, []);
  assert.equal(m.url, "https://www.facebook.com/reel/987");
  assert.equal(m.username, "Host Jasmine");
  assert.equal(m.caption, "full untruncated message #tag");
  assert.equal(m.imageUrl, "https://scontent.fbcdn.net/v/img.jpg?sig=1");
  assert.equal(m.takenAt, 1756100000);
});

test("captured story fields win over React-prop fields", async () => {
  const { mergeFbRecords } = await import("../src/services/capture.service.js");
  const dom = [{
    platform: "facebook",
    id: "fb:cxyz",
    text: "the real message text from the card",
    propUsername: "From Props",
  }];
  const captured = [{
    post_id: "555", url: "https://www.facebook.com/555",
    caption: "the real message text from the card, in full",
    username: "From Capture", imageUrl: null, likeCount: 7, commentCount: 1, takenAt: null,
  }];
  const [m] = mergeFbRecords(dom, captured);
  assert.equal(m.username, "From Capture");
  assert.equal(m.url, "https://www.facebook.com/555");
});

test("mergeRecords uses IG React-prop fields when capture missed the post", async () => {
  const { mergeRecords } = await import("../src/services/capture.service.js");
  const dom = [{
    platform: "instagram",
    id: "ig:p/ABC",
    url: "https://www.instagram.com/p/ABC",
    preview: "alt text",
    propUsername: "acme_co",
    propCaption: "full caption #x",
    propTakenAt: 1756100000,
    propLikeCount: 12,
    propCommentCount: 3,
  }];
  const [m] = mergeRecords(dom, []);
  assert.equal(m.username, "acme_co");
  assert.equal(m.caption, "full caption #x");
  assert.equal(m.takenAt, 1756100000);
  assert.equal(m.likeCount, 12);
  assert.equal(m.commentCount, 3);
});

/* ---------------- FB author recovery ---------------- */

test("mergeFbRecords decodes a b64-tagged author past the bridge's redaction", async () => {
  const { mergeFbRecords } = await import("../src/services/capture.service.js");
  const utf8b64 = "b64:" + Buffer.from("Nice Print Photography — Tagaytay", "utf8").toString("base64");
  const dom = [{ platform: "facebook", id: "fb:c1", text: "some card text", author: utf8b64 }];
  const [m] = mergeFbRecords(dom, []);
  assert.equal(m.author, "Nice Print Photography — Tagaytay");
});

test("mergeFbRecords falls back to the card text's leading name for author", async () => {
  const { mergeFbRecords } = await import("../src/services/capture.service.js");
  const dom = [{ platform: "facebook", id: "fb:c2", author: null,
    text: "Host Jasmine · Follow · Program briefing with the coor." }];
  const [m] = mergeFbRecords(dom, []);
  assert.equal(m.author, "Host Jasmine");
});

test("fbNameFromCardText extracts the leading page/person name", async () => {
  const { fbNameFromCardText } = await import("../src/services/capture.service.js");
  const cases = [
    ["Host Jasmine · Follow · Program briefing", "Host Jasmine"],
    ["Online status indicator Active Host Jasmine · Follow · x", "Host Jasmine"],
    ["Glass Garden and Rhen Ttp · Pasig · Made of Dreams", "Glass Garden and Rhen Ttp"],
    ["Nice Print Photography & Exige Weddings is at Antonio's, Tagaytay. · Follow", "Nice Print Photography & Exige Weddings"],
    ["The Organic Studios is with Trisha Gauce at Communal Ranch", "The Organic Studios"],
    ["Concept A is in Tagaytay. · Follow", "Concept A"],
    ["Album RENSIE & AMOR // Dream Wedding Package Online status", null],
    ["", null],
  ];
  for (const [input, want] of cases) {
    assert.equal(fbNameFromCardText(input), want, JSON.stringify(input));
  }
});

test("fbNameFromCardText finds the name after an album title", async () => {
  const { fbNameFromCardText } = await import("../src/services/capture.service.js");
  assert.equal(
    fbNameFromCardText("Album RENSIE & AMOR // Dream Wedding Package Online status indicator Active Eventistry Events · Follow · caption"),
    "Eventistry Events",
  );
  // An album card with no post-title marker still refuses to guess.
  assert.equal(fbNameFromCardText("Album RENSIE & AMOR // Dream Wedding Package"), null);
});
