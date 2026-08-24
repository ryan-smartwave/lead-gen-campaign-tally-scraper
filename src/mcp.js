import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Exported so the web UI can show this remedy verbatim — it describes a manual
// browser action no program can perform, so the two copies must never drift.
export const BUSY_HINT =
  'mcp-chrome already holds a session. Reset it: open chrome://extensions, click the ' +
  'reload icon on "Chrome MCP Server", reopen its popup (Service Running · Port 12306), then re-run.';

export async function connect(endpoint, { retries = 3, retryDelayMs = 2000, onEvent } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const client = new Client({ name: "smartwave-social-scraper", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    try {
      await client.connect(transport);
      client.__transport = transport;
      return client;
    } catch (err) {
      lastErr = err;
      await client.close().catch(() => {});
      // The single held transport won't clear by retrying — fail fast with the reset steps.
      if (/already connected to a transport/i.test(err.message)) {
        throw new Error(BUSY_HINT);
      }
      // Transient (server still coming up after a reconnect): worth another try.
      if (attempt < retries) {
        if (onEvent) onEvent({ attempt, retries, retryDelayMs, message: err.message });
        else
          console.warn(
            `  connect attempt ${attempt}/${retries} failed (${err.message}); retrying in ${retryDelayMs}ms ...`,
          );
        await sleep(retryDelayMs);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Terminate the server-side session (DELETE) before closing, so we never leave a ghost
// that blocks the next run. No-op if the server doesn't implement session termination.
export async function disconnect(client) {
  if (!client) return;
  try {
    await client.__transport?.terminateSession?.();
  } catch {
    /* server may not support DELETE termination; harmless */
  }
  await client.close().catch(() => {});
}

export async function callTool(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (res.isError) throw new Error(`${name} failed: ${text.slice(0, 500)}`);
  return text;
}

// Run JS in the active tab via chrome_javascript and return the parsed result.
// mcp-chrome wraps the return as {success, result:"<json string>"}; unwrap both layers.
export async function evalJs(client, code, opts = {}) {
  const raw = await callTool(client, "chrome_javascript", { code, ...opts });
  let outer;
  try {
    outer = JSON.parse(raw);
  } catch {
    throw new Error(`chrome_javascript: unparseable wrapper: ${raw.slice(0, 200)}`);
  }
  if (outer.success === false) {
    throw new Error(`chrome_javascript: ${JSON.stringify(outer.error)}`);
  }
  const r = outer.result;
  if (typeof r === "string") {
    try {
      return JSON.parse(r);
    } catch {
      return r;
    }
  }
  return r;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
