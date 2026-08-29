import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureIncident } from "../src/services/incident.service.js";
import { BlockError } from "../src/services/safety.service.js";

test("writes incident.json with reason, url and journal tail", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inc-"));
  const journal = { tail: () => [{ action: "navigate" }, { action: "danger" }] };
  const err = new BlockError("checkpoint at x", { reason: "checkpoint", url: "https://x/checkpoint" });
  const { incidentDir } = await captureIncident({
    root, runId: "2026-08-25T00:00:00.000Z", campaign: "b", error: err, journal,
    client: { fake: true }, caps: { screenshot: false },
    deps: { evalJs: async () => "PAGE TEXT" },
  });
  const bundle = JSON.parse(fs.readFileSync(path.join(incidentDir, "incident.json"), "utf8"));
  assert.equal(bundle.reason, "checkpoint");
  assert.equal(bundle.url, "https://x/checkpoint");
  assert.equal(bundle.tail.length, 2);
  assert.equal(fs.readFileSync(path.join(incidentDir, "page.txt"), "utf8"), "PAGE TEXT");
  const index = fs.readFileSync(path.join(root, "data", "incidents", "index.log"), "utf8");
  assert.match(index, /checkpoint/);
});

test("a failing page-text grab still yields a bundle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inc-"));
  const journal = { tail: () => [] };
  const { incidentDir } = await captureIncident({
    root, runId: "2026-08-25T00:00:00.000Z", campaign: "b",
    error: new Error("plain"), journal, client: {}, caps: { screenshot: false },
    deps: { evalJs: async () => { throw new Error("no page"); } },
  });
  assert.ok(fs.existsSync(path.join(incidentDir, "incident.json")));
});
