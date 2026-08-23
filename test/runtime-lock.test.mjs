import test from "node:test";
import assert from "node:assert/strict";
import { makeBaseCtx, setupRuntime, user, assistant } from "./runtime-helpers.mjs";

async function startAgentFirst(pi, toolCtx, commandCtx) {
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [1]; // Agent direct
  await pi.commands.get("midcompact").handler("start", commandCtx);
  return pi.tools.get("midcompact");
}

test("planning lock: Agent turn blocks Selection until the turn settles", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  await startAgentFirst(pi, toolCtx, commandCtx);
  const frameCount = toolCtx.ui.reviewFrames.length;

  await pi.emit("agent_start", { type: "agent_start" }, toolCtx);
  await pi.commands.get("midcompact").handler("select", commandCtx);
  assert.equal(toolCtx.ui.reviewFrames.length, frameCount);
  assert.match(toolCtx.ui.messages.at(-1).text, /Agent is currently processing/i);

  await pi.emit("agent_settled", { type: "agent_settled" }, toolCtx);
  toolCtx.ui.customInputs = ["\x1b"];
  await pi.commands.get("midcompact").handler("select", commandCtx);
  assert.equal(toolCtx.ui.reviewFrames.length, frameCount + 1);
  assert.match(toolCtx.ui.messages.at(-1).text, /Selection closed/i);
});

test("planning lock: UI holding the lock blocks Agent plan mutation and returns a clear message", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  const tool = await startAgentFirst(pi, toolCtx, commandCtx);
  // Simulate the user opening a UI first.
  assert.equal(pi.midcompactPlanningLock.tryAcquireUi(), true);
  // Agent plan mutation is rejected.
  const res = await tool.execute("tc1", { action: "plan", op: "add", start: "a0001", end: "a0002" }, null, null, toolCtx);
  assert.match(res.content[0].text, /blocked.*planning lock|UI.*editing/i);
  assert.match(toolCtx.ui.messages.at(-1).text, /UI is currently editing/i);
  // The DraftPlan is unchanged.
  const show = await tool.execute("tc2", { action: "plan", op: "show" }, null, null, toolCtx);
  assert.doesNotMatch(show.content[0].text, /d1:/);
});

test("planning lock: reload does not restore the old lock but DraftPlan is restored", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { sm, pi, toolCtx, commandCtx } = setupRuntime(entries);
  const tool = await startAgentFirst(pi, toolCtx, commandCtx);
  await tool.execute("tc1", { action: "plan", op: "add", start: "a0001", end: "a0002" }, null, null, toolCtx);
  await tool.execute("tc2", { action: "plan", op: "update", draft_id: "d1", summary: "filled." }, null, null, toolCtx);
  // Simulate reload on a fresh context.
  const freshCtx = makeBaseCtx(sm);
  await pi.emit("session_start", { reason: "reload" }, freshCtx);
  // The old Agent lock is gone, so UI access is available; the DraftPlan remains.
  assert.equal(pi.midcompactPlanningLock.tryAcquireUi(), true);
  pi.midcompactPlanningLock.releaseUi();
  const show = await tool.execute("tc3", { action: "plan", op: "show" }, null, null, freshCtx);
  assert.match(show.content[0].text, /d1:/);
  assert.match(show.content[0].text, /summarized/);
});
