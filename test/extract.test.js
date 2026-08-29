import { test } from "node:test";
import assert from "node:assert/strict";

// The in-page extraction scripts are strings evaluated in the tab; a syntax
// error there is silent in unit tests but fatal in a live run. Parsing them as
// function bodies catches typos without needing a DOM.
test("extraction scripts parse as valid function bodies", async () => {
  const { IG_EXTRACT, FB_EXTRACT } = await import("../src/services/extract.service.js");
  assert.doesNotThrow(() => new Function(IG_EXTRACT));
  assert.doesNotThrow(() => new Function(FB_EXTRACT));
});

test("capture scripts parse as valid function bodies", async () => {
  const mod = await import("../src/services/capture.service.js");
  for (const name of ["IG_CAPTURE_INSTALL", "IG_CAPTURE_HARVEST", "IG_CAPTURE_DRAIN", "FB_CAPTURE_HARVEST", "FB_CAPTURE_DRAIN"]) {
    assert.doesNotThrow(() => new Function(mod[name]), name);
  }
});
