import { connect, disconnect, callTool, evalJs, sleep } from "./src/mcp.js";
import { FB_EXTRACT, IG_EXTRACT } from "./src/extract.js";

const url = process.argv[2] || "https://www.facebook.com/search/posts?q=%23weddingphilippines";
const isIG = url.includes("instagram.com");

const c = await connect("http://127.0.0.1:12306/mcp");
try {
  console.log("navigating:", url);
  await callTool(c, "chrome_navigate", { url });
  await sleep(8000);
  for (let i = 0; i < 6; i++) {
    await evalJs(c, "window.scrollBy(0, window.innerHeight); return true;").catch(() => {});
    await sleep(3000);
  }
  const res = await evalJs(c, isIG ? IG_EXTRACT : FB_EXTRACT);
  console.log("loggedOut:", res.loggedOut, "| posts found:", res.posts.length);
  for (const p of res.posts.slice(0, 12)) {
    console.log(`  ${p.id}  author=${p.author ?? "?"}  :: ${(p.text ?? p.preview ?? "").slice(0, 90)}`);
  }
} finally {
  await disconnect(c);
}
