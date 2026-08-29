import { test } from "node:test";
import assert from "node:assert/strict";
import { humanScroll } from "../src/services/safety.service.js";

/** A client whose chrome_javascript always succeeds, counting scroll evals. */
function fakeClient() {
  const calls = [];
  return {
    calls,
    callTool: async ({ name, arguments: args }) => {
      calls.push(args.code);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, result: "true" }) }] };
    },
  };
}

function journalSpy() {
  const types = [];
  return { types, log: (type) => types.push(type) };
}

test("humanScroll steps mode runs exactly N steps", async () => {
  const client = fakeClient();
  let onStepCalls = 0;
  await humanScroll(client, { steps: 3, scrollPauseMs: [0, 0] }, null, async () => {
    onStepCalls++;
  });
  const scrolls = client.calls.filter((c) => c.includes("scrollBy")).length;
  assert.equal(scrolls, 3);
  assert.equal(onStepCalls, 3);
});

test("humanScroll stops early when onStep returns false", async () => {
  const client = fakeClient();
  let i = 0;
  // A huge time budget that would run for minutes if the early-stop failed.
  await humanScroll(client, { minutes: [10, 10], scrollPauseMs: [0, 0] }, null, async () => {
    i++;
    if (i >= 3) return false;
  });
  const scrolls = client.calls.filter((c) => c.includes("scrollBy")).length;
  assert.equal(scrolls, 3, "the scroll ended on the step whose onStep returned false");
});

test("humanScroll minutes mode stops when the time budget is spent", async () => {
  const client = fakeClient();
  // 60ms budget, ~25ms per step: a few iterations, then the loop must end.
  await humanScroll(client, { minutes: [0.001, 0.001], scrollPauseMs: [25, 25] }, null);
  const scrolls = client.calls.filter((c) => c.includes("scrollBy")).length;
  assert.ok(scrolls >= 1, "at least one step ran");
  assert.ok(scrolls <= 20, `budget ended the loop (ran ${scrolls} steps)`);
});

test("humanScroll takes journaled rest breaks in deep mode", async () => {
  const client = fakeClient();
  const journal = journalSpy();
  await humanScroll(
    client,
    { steps: 3, scrollPauseMs: [0, 0], restEveryMs: [1, 1], restPauseMs: [1, 1] },
    journal,
  );
  assert.ok(journal.types.includes("scroll"));
  assert.ok(journal.types.includes("rest"), "rest breaks are journaled like every other action");
});

test("humanScroll without rest pairs never rests (legacy behavior)", async () => {
  const client = fakeClient();
  const journal = journalSpy();
  await humanScroll(client, { steps: 2, scrollPauseMs: [0, 0] }, journal);
  assert.ok(!journal.types.includes("rest"));
});
