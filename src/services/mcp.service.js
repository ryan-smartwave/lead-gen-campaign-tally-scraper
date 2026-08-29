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

/**
 * Passive network capture through the extension's debugger backend — the only
 * reliable way to read Instagram's API responses. In-page fetch/XHR patching
 * cannot work: the page binds its own reference to fetch at bootstrap, and the
 * initial data burst fires before any post-load script could install.
 *
 * Starting WITH the url makes the extension open/navigate the tab itself, so
 * the initial burst is captured too. Purely observational: not one extra
 * request is sent.
 */
export async function startNetCapture(client, url, maxCaptureTime = 15 * 60_000) {
  const raw = await callTool(client, "chrome_network_capture", {
    action: "start",
    needResponseBody: true,
    url,
    maxCaptureTime,
    inactivityTimeout: 0,
  });
  const res = JSON.parse(raw);
  if (!res?.success) throw new Error(`network capture start refused: ${raw.slice(0, 200)}`);
  return { tabId: typeof res.tabId === "number" ? res.tabId : null };
}

/** Stop the capture and return its payload ({requests: [...]}, see blobsFromNetworkCapture). */
export async function stopNetCapture(client) {
  const raw = await callTool(client, "chrome_network_capture", { action: "stop" });
  return JSON.parse(raw);
}

/**
 * Restart capture on the CURRENT tab, without a url (a url would make the
 * extension navigate — mid-scroll that would reset the feed). Used to cycle
 * capture during long scrolls: each stop payload stays small enough to survive
 * the bridge, while coverage of the pagination traffic stays continuous.
 * Throws if the extension refuses; callers degrade gracefully.
 */
export async function resumeNetCapture(client, maxCaptureTime = 5 * 60_000) {
  const raw = await callTool(client, "chrome_network_capture", {
    action: "start",
    needResponseBody: true,
    maxCaptureTime,
    inactivityTimeout: 0,
  });
  const res = JSON.parse(raw);
  if (!res?.success) throw new Error(`network capture resume refused: ${raw.slice(0, 200)}`);
}

export async function switchTab(client, tabId) {
  await callTool(client, "chrome_switch_tab", { tabId });
}

export async function closeTabs(client, tabIds) {
  await callTool(client, "chrome_close_tabs", { tabIds });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function detectCaps(client) {
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name.toLowerCase());
    return {
      tabs: names.some((n) => n.includes("tab")),
      screenshot: names.some((n) => n.includes("screenshot")),
      // resolved tool names for the tab ops, best-effort:
      names,
    };
  } catch {
    return { tabs: false, screenshot: false, names: [] };
  }
}

export async function screenshot(client) {
  try {
    const res = await client.callTool({ name: "chrome_screenshot", arguments: {} });
    const img = (res.content ?? []).find((c) => c.type === "image");
    return img?.data ? Buffer.from(img.data, "base64") : null;
  } catch {
    return null;
  }
}
