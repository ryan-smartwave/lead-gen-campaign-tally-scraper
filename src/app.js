import express from "express";
import cors from "cors";
import routes from "./routes/index.js";
import { notFound, errorHandler } from "./middlewares/error.js";
import { serverConfig } from "./config/env.js";

/**
 * The Express application.
 *
 * Kept separate from starting the listener so tests can exercise routes without
 * binding a port.
 */
export function createApp() {
  const { allowedOrigins } = serverConfig();
  const app = express();

  // Behind nothing, but this keeps req.ip honest if that ever changes.
  app.set("trust proxy", "loopback");
  app.disable("x-powered-by");

  app.use(express.json({ limit: "1mb" }));

  // Only the UI's origin may call this from a browser. The service drives a real
  // signed-in browser, so a permissive policy here would be a genuine hazard.
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        callback(null, false);
      },
    }),
  );

  app.use("/", routes);
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
