import fs from "node:fs";
import path from "node:path";
import { sanitizeRunId } from "./journal.service.js";

const PAGE_TEXT = `return (document.body ? document.body.innerText : '').slice(0, 50000);`;

export async function captureIncident({ root, runId, business, error, journal, client, caps = {}, deps = {} }) {
  const base = path.join(root, "data", "incidents");
  const incidentDir = path.join(base, sanitizeRunId(runId));
  const reason = error?.reason ?? "unknown";
  const url = error?.url ?? null;

  try { fs.mkdirSync(incidentDir, { recursive: true }); } catch { /* best effort */ }

  const bundle = {
    at: new Date().toISOString(), runId, business, reason, url,
    context: error?.message ?? String(error), tail: (() => { try { return journal?.tail?.(50) ?? []; } catch { return []; } })(),
  };
  try { fs.writeFileSync(path.join(incidentDir, "incident.json"), JSON.stringify(bundle, null, 2)); } catch { /* swallow */ }

  // Best-effort page text.
  try {
    if (deps.evalJs) {
      const text = await deps.evalJs(client, PAGE_TEXT);
      if (typeof text === "string") fs.writeFileSync(path.join(incidentDir, "page.txt"), text);
    }
  } catch { /* swallow */ }

  // Best-effort screenshot (only if the tool exists).
  try {
    if (caps.screenshot && deps.screenshot) {
      const png = await deps.screenshot(client);
      if (png) fs.writeFileSync(path.join(incidentDir, "screenshot.png"), png);
    }
  } catch { /* swallow */ }

  try {
    fs.mkdirSync(base, { recursive: true });
    fs.appendFileSync(path.join(base, "index.log"),
      `${bundle.at}\t${business}\t${runId}\t${reason}\t${url ?? ""}\n`);
  } catch { /* swallow */ }

  return { incidentDir };
}
