import {
  startRun,
  snapshot,
  stop,
  clearFinished,
  isRunning,
  subscribe,
} from "../services/supervisor.service.js";
import { BUSY_HINT } from "../services/mcp.service.js";
import { ApiError } from "../utils/ApiError.js";

const STATUS_FOR = {
  ALREADY_RUNNING: 409,
  ALREADY_RAN_TODAY: 409,
  DB_NOT_CONFIGURED: 503,
  // The database refused the run row, or was unreachable. Nothing was started.
  STORE_UNAVAILABLE: 503,
};

/** Starts a run and returns as soon as it has begun; the run continues here. */
export async function create(req, res) {
  try {
    const started = await startRun({
      business: req.body?.business,
      force: req.body?.force === true,
      store: req.body?.store === "file" ? "file" : "database",
    });
    res.status(202).json(started);
  } catch (err) {
    throw new ApiError(
      STATUS_FOR[err.code] ?? 500,
      (err.code ?? "start_failed").toLowerCase(),
      err.message,
      /already connected to a transport/i.test(err.message) ? { hint: BUSY_HINT } : {},
    );
  }
}

/**
 * The replayable snapshot. A client that just started a run and one that
 * reloaded twenty minutes later both call this and reduce the same events, which
 * is what makes resuming a non-event rather than a special case.
 */
export async function active(_req, res) {
  res.json(snapshot());
}

/** Stops a live run, or clears a finished one's log. */
export async function stopOrClear(_req, res) {
  if (isRunning()) return res.json({ stopping: stop() });
  res.json({ cleared: clearFinished() });
}

/**
 * Server-sent events for the live run.
 *
 * The keep-alive ping is not optional: gaps between hashtags are 3–7 minutes by
 * design, which exceeds common idle timeouts, and a stream dropped during a
 * deliberate silence looks exactly like a crashed run.
 */
export async function events(req, res) {
  const since = Number(req.query.sinceSeq ?? 0);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (chunk) => {
    if (!res.writableEnded) res.write(chunk);
  };
  const frame = (event) =>
    send(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

  const snap = snapshot();
  send(
    `event: hello\ndata: ${JSON.stringify({
      firstSeq: snap.firstSeq,
      lastSeq: snap.lastSeq,
      active: snap.active,
    })}\n\n`,
  );
  for (const event of snap.events) if (event.seq > since) frame(event);

  const unsubscribe = subscribe(frame);
  const ping = setInterval(() => send(": ping\n\n"), 20_000);

  const close = () => {
    clearInterval(ping);
    unsubscribe();
    if (!res.writableEnded) res.end();
  };
  req.on("close", close);
  req.on("error", close);
}
