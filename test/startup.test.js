import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENTRY = path.join(ROOT, "src", "index.js");

/** Holds a port so the service under test cannot have it. */
function occupy() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, server }));
  });
}

function startService(port) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [ENTRY],
      { cwd: ROOT, env: { ...process.env, SCRAPER_PORT: String(port), SCRAPER_HOST: "127.0.0.1" }, timeout: 45_000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }),
    );
    child.unref();
  });
}

/**
 * Windows binds before it listens, so an occupied port is reported after the
 * "listening" banner has already printed. The failure must still be visible and
 * the exit code non-zero — otherwise the service looks started, then silently
 * disappears when the pool's idle socket times out.
 */
test("a port already in use fails loudly instead of exiting silently", async () => {
  const { port, server } = await occupy();
  try {
    const { code, stdout, stderr } = await startService(port);
    const output = `${stdout}${stderr}`;

    assert.notEqual(code, 0, `expected a non-zero exit, got ${code}. Output:\n${output}`);
    assert.match(output, /already in use|EADDRINUSE/i, `expected the port clash to be reported. Output:\n${output}`);
    assert.match(output, new RegExp(String(port)), "the message should name the port");
  } finally {
    server.close();
  }
});
