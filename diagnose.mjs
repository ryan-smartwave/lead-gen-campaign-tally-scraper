// Diagnostic: run the REAL collect() pipeline once for one hashtag, with
// abbreviated (but still jittered) pacing, and report how many posts and how
// many rich fields came back. Usage:
//
//   node diagnose.mjs [instagram|facebook] [hashtag]
//
// Defaults to instagram weddingsph. Exercises navigation-with-network-capture,
// the danger checks, DOM extraction and the capture merge — everything a
// scheduled run does for one hashtag, minus the long gaps.
import { connect, disconnect } from "./src/services/mcp.service.js";
import { collect } from "./src/services/run.service.js";

const platform = process.argv[2] || "instagram";
const value = process.argv[3] || "weddingsph";

const safety = {
  pageLoadDelayMs: 6000,
  initialDwellMs: [1500, 2500],
  scrollsPerHashtag: 3,
  scrollPauseMs: [2000, 4000],
};

const journal = { log: (action, data = {}) => console.log(`  [${action}]`, JSON.stringify(data)) };

const c = await connect("http://127.0.0.1:12306/mcp");
try {
  console.log(`collecting ${platform} #${value} ...`);
  const posts = await collect(c, { platform, value }, safety, { journal });
  console.log(`posts found: ${posts.length}`);
  const rich = posts.filter((p) => p.username || p.likeCount != null);
  const withImage = posts.filter((p) => p.imageUrl).length;
  const withTakenAt = posts.filter((p) => p.takenAt != null).length;
  if (platform === "instagram") {
    console.log(`  with username/likes: ${rich.length} | with image: ${withImage} | with takenAt: ${withTakenAt}`);
  }
  for (const p of posts.slice(0, 8)) {
    console.log(
      `  ${p.id}  user=${p.username ?? p.author ?? "?"}  likes=${p.likeCount ?? "?"}  :: ${(p.caption ?? p.text ?? "").slice(0, 70)}`,
    );
  }
} finally {
  await disconnect(c);
}
