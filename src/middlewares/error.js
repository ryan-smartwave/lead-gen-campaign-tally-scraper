import { ApiError } from "../utils/ApiError.js";

/** Anything not matched by a router. */
export function notFound(req, res) {
  res.status(404).json({
    error: "not_found",
    message: `No route for ${req.method} ${req.path}.`,
  });
}

/**
 * Single place that turns a thrown error into a response.
 *
 * An ApiError carries its own status and code; anything else is a genuine bug
 * and becomes a 500 with its message, which is acceptable because this service
 * only ever listens on loopback for its own operator.
 */
export function errorHandler(err, _req, res, _next) {
  if (res.headersSent) return res.end();

  if (err instanceof ApiError) {
    const { status, code, message, ...extra } = err;
    return res.status(status).json({ error: code, message, ...stripNoise(extra) });
  }

  console.error("unhandled error:", err);
  res.status(500).json({ error: "internal", message: err.message });
}

function stripNoise({ name, stack, ...rest }) {
  return rest;
}
