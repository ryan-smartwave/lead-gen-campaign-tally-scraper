import fs from "node:fs";
import path from "node:path";

/**
 * A one-line-per-run record of which campaign ran on which day.
 *
 * This is the only thing a database-backed run leaves on disk, and it holds no
 * scraped content — just a date, a run id and an outcome. It exists because the
 * once-a-day guard must not be forgettable: if its only memory were the
 * database, clearing the database would silently re-open a second run on the
 * same day, and blocks escalate when you retry through them.
 *
 * Lives beside the lock, because both are operational state rather than results.
 */

export function ledgerPath(root) {
  return path.join(root, "data", "runs.log");
}

export function appendLedger(root, entry) {
  try {
    const file = ledgerPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
  } catch {
    /* the guard falls back to the database; never break a run over this */
  }
}

export function readLedger(root) {
  let text;
  try {
    text = fs.readFileSync(ledgerPath(root), "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* skip a malformed line */
    }
  }
  return entries;
}

export function ledgerHasRun(root, campaign, day) {
  return readLedger(root).some((e) => e.campaign === campaign && e.day === day);
}
