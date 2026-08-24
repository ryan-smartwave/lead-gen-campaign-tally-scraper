import net from "node:net";

/**
 * Bare TCP reachability check for the mcp-chrome bridge.
 *
 * Deliberately not an MCP handshake. The bridge holds exactly one session, so
 * opening a real one here would create the "already connected to a transport"
 * state this is meant to detect — the check would cause the problem it reports.
 * This is weaker than `npm run check` on purpose.
 */
export function probeMcp(endpoint, timeoutMs = 1200) {
  let host = "127.0.0.1";
  let port = 12306;
  try {
    const url = new URL(endpoint);
    host = url.hostname || host;
    port = Number(url.port) || port;
  } catch {
    /* fall back to defaults */
  }

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (reachable, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, detail });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, `${host}:${port} is accepting connections`));
    socket.once("timeout", () => finish(false, `${host}:${port} did not answer in ${timeoutMs}ms`));
    socket.once("error", (err) =>
      finish(
        false,
        err.code === "ECONNREFUSED"
          ? `nothing is listening on ${host}:${port}`
          : `${host}:${port} error: ${err.code ?? err.message}`,
      ),
    );
    socket.connect(port, host);
  });
}
