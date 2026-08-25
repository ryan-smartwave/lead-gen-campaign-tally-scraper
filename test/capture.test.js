import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCaptured, mergeRecords } from "../src/services/capture.service.js";

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
});
