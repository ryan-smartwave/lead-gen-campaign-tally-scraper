import fs from "node:fs";
import path from "node:path";

export function sanitizeRunId(runId) {
  return String(runId).replace(/[:*?"<>|]/g, "-");
}

export function createJournal({ root, runId, campaign, retentionDays = 30 }) {
  const dir = path.join(root, "data", "journal");
  const file = path.join(dir, `${sanitizeRunId(runId)}.jsonl`);
  let seq = 0;

  try {
    fs.mkdirSync(dir, { recursive: true });
    // Prune old journals so months of daily runs don't accumulate unbounded.
    const cutoff = Date.now() - retentionDays * 86400_000;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }); } catch { /* skip */ }
    }
  } catch { /* journal is best-effort */ }

  const log = (action, data = {}) => {
    const entry = { at: new Date().toISOString(), seq: ++seq, action, ...data };
    try { fs.appendFileSync(file, JSON.stringify(entry) + "\n"); } catch { /* swallow */ }
  };

  const tail = (n) => {
    try {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
      return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  };

  log("run_start", { campaign, detail: { runId } });
  return { log, tail, path: file, dir };
}
