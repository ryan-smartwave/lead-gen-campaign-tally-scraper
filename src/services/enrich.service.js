import { normalizeCaptured, IG_POST_EXTRACT } from "./capture.service.js";
import { BlockError } from "./safety.service.js";

const missing = (r) => r.takenAt == null || r.caption == null || r.username == null;

export function selectForEnrichment(records, cap) {
  const out = [];
  for (const r of records) {
    if (out.length >= cap) break;      // check BEFORE pushing; also handles cap<=0
    if (r.platform !== "instagram") continue;
    if (missing(r)) out.push(r);
  }
  return out;
}

const shortcode = (id) => (typeof id === "string" ? id.split("/").pop() : null);

export async function enrichPost(client, record, deps) {
  const { navigate, evalJs, assertSafe, sleep, pageLoadDelayMs, dwellMs, journal } = deps;
  const url = record.url || `https://www.instagram.com/p/${shortcode(record.id)}/`;
  journal?.log?.("post_visit", { platform: "instagram", detail: { id: record.id } });
  await navigate(client, url);
  await sleep(pageLoadDelayMs);
  await assertSafe(client, `enrich ${record.id}`);
  await sleep(dwellMs);

  const res = await evalJs(client, IG_POST_EXTRACT);
  if (res?.loggedOut) throw new BlockError(`not logged in during enrich ${record.id}`, { reason: "login_wall", url });

  const [found] = normalizeCaptured({ responses: res?.responses ?? [], inline: res?.inline ?? [] })
    .filter((r) => shortcode(r.id) === shortcode(record.id));
  const out = { ...record, enrichedAt: new Date().toISOString() };
  if (found) {
    for (const k of ["takenAt", "caption", "username", "imageUrl", "likeCount", "commentCount"]) {
      if (out[k] == null && found[k] != null) out[k] = found[k];
    }
  }
  if (out.imageUrl == null && res?.ogImage) out.imageUrl = res.ogImage;
  return out;
}
