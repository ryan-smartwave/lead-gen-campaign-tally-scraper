/**
 * An error that carries the HTTP status and machine-readable code a client
 * should see, so controllers can throw rather than hand-rolling responses.
 */
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Wraps an async handler so a rejected promise reaches the error middleware.
 * Express 5 forwards rejections automatically, but being explicit keeps the
 * behaviour obvious and survives a downgrade.
 */
export const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
