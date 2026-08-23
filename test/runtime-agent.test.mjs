import test from "node:test";
import assert from "node:assert/strict";
import { setupRuntime, user, assistant } from "./runtime-helpers.mjs";

/** Drive the Agent-first workflow end-to-end via the tool surface. */
async function runAgentFirstWorkflow(pi, toolCtx, commandCtx, { instructions } = {}) {
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [0]; // Agent direct (first option)
  await pi.commands.get("midcompact").handler(`start ${instructions ?? ""}`.trim(), commandCtx);
  assert.match(pi.sentUserMessages.at(-1), /read the `midcompact` skill before doing any planning work/i);
  const tool = pi.tools.get("midcompact");

  // Agent inspects first.
  const inspected = await tool.execute("tc-inspect", { action: "inspect" }, null, null, toolCtx);
  assert.match(inspected.content[0].text, /content chars/i);

  // Agent adds a range with an empty (pending) summary — allowed without confirm/select.
  const added = await tool.execute("tc-add", {
    action: "plan", op: "add", start: "a0001", end: "a0002",
  }, null, null, toolCtx);
  assert.match(added.content[0].text, /added d1/);
  assert.match(added.content[0].text, /pending summary/);
  assert.doesNotMatch(added.content[0].text, /Context awareness/);

  // Agent fills the summary via update.
  const updated = await tool.execute("tc-update", {
    action: "plan", op: "update", draft_id: "d1", summary: "Phase one summarized.",
  }, null, null, toolCtx);
  assert.match(updated.content[0].text, /updated d1/);
  assert.match(updated.content[0].text, /summarized/);
  assert.match(updated.content[0].text, /summary: Phase one summarized\./);
  assert.doesNotMatch(updated.content[0].text, /Context awareness/);
  assert.doesNotMatch(updated.content[0].text, /projected if committed now/);
  assert.match(updated.content[0].text, /content chars/);

  // Explicit show owns full awareness and the complete current range list.
  const shown = await tool.execute("tc-show", { action: "plan", op: "show" }, null, null, toolCtx);
  assert.match(shown.content[0].text, /Context awareness/);
  assert.match(shown.content[0].text, /summary: Phase one summarized\./);
  assert.match(toolCtx.ui.statuses.get("midcompact"), /MC planning/);
  return tool;
}

test("Agent-first workflow: inspect → plan add (pending) → update → review → commit, then tree rollback restores raw history", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("old requirement", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
    { type: "message", id: "e3", parentId: "e2", message: user("current work", 3) },
  ];
  const { sm, pi, toolCtx, commandCtx } = setupRuntime(entries);

  const tool = await runAgentFirstWorkflow(pi, toolCtx, commandCtx, { instructions: "Compress old exploration only" });
  await pi.emit("agent_settled", { type: "agent_settled" }, toolCtx);

  // Review UI still maps ranges and KEEP holes.
  await pi.commands.get("midcompact").handler("review", commandCtx);
  assert.ok(toolCtx.ui.reviewFrames.length > 0);
  assert.match(toolCtx.ui.reviewFrames.at(-1).join("\n"), /Midcompact Review/);
  assert.match(toolCtx.ui.reviewFrames.at(-1).join("\n"), /d1/);
  assert.match(toolCtx.ui.reviewFrames.at(-1).join("\n"), /KEEP/);

  assert.equal("navigateTree" in toolCtx, false, "tool context must not expose command-only session navigation");
  await pi.commands.get("midcompact").handler("commit", commandCtx);

  const committedLeaf = sm.leafId;
  const committedEntry = [...entries].reverse().find(e => e.customType === "midcompact-state");
  assert.ok(committedEntry);
  assert.equal(committedEntry.parentId, "e3");
  assert.equal(sm.getBranch().some(e => e.customType === "midcompact-transaction"), false);
  assert.match(pi.labels.get(committedEntry.id), /^midcompact/);
  assert.equal(toolCtx.ui.statuses.has("midcompact"), false);
  assert.ok(pi.entryRenderers.has("midcompact-state"));
  assert.equal(committedEntry.data.lastCommit.anchorUsage.percent, 70);
  assert.equal(committedEntry.data.lastCommit.anchorUsage.contextWindow, 100000);
  assert.equal(typeof committedEntry.data.lastCommit.selectedOriginalContentChars, "number");
  assert.equal(typeof committedEntry.data.lastCommit.selectedReplacementContentChars, "number");

  const rawMessages = [user("old requirement", 1), assistant("old exploration", 2), user("current work", 3)];
  const projected = await pi.emit("context", { messages: structuredClone(rawMessages) }, toolCtx);
  assert.equal(projected.messages.length, 2);
  assert.equal(projected.messages[0].customType, "midcompact-summary");
  assert.equal(projected.messages[1].content, "current work");

  await commandCtx.navigateTree("e2", { summarize: false });
  const rolledBack = await pi.emit("context", { messages: structuredClone(rawMessages.slice(0, 2)) }, toolCtx);
  assert.equal(rolledBack, undefined);

  await commandCtx.navigateTree(committedLeaf, { summarize: false });
  const restored = await pi.emit("context", { messages: structuredClone(rawMessages) }, toolCtx);
  assert.equal(restored.messages[0].customType, "midcompact-summary");

  const search = await tool.execute("tc4", { action: "recall" }, null, null, toolCtx);
  assert.match(search.content[0].text, /c0001/);
  const recalled = await tool.execute("tc5", { action: "recall", ref: "c0001", detail: "full" }, null, null, toolCtx);
  assert.match(recalled.content[0].text, /old requirement/);
  assert.match(recalled.content[0].text, /old exploration/);

  // A later transaction retains c0001 and compresses only newly accumulated raw history.
  const newUserId = `x${++pi.counter}`;
  entries.push({ type: "message", id: newUserId, parentId: sm.leafId, message: user("new phase request", pi.counter) });
  sm.leafId = newUserId;
  const newAssistantId = `x${++pi.counter}`;
  entries.push({ type: "message", id: newAssistantId, parentId: sm.leafId, message: assistant("new phase exploration", pi.counter) });
  sm.leafId = newAssistantId;

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [0]; // Agent direct (first option)
  await pi.commands.get("midcompact").handler("start", commandCtx);
  const inspect2 = await tool.execute("tc-inspect2", { action: "inspect" }, null, null, toolCtx);
  assert.match(inspect2.content[0].text, /compressed.*protected|protected/);
  await tool.execute("tc-add2", { action: "plan", op: "add", start: "a0003", end: "a0004" }, null, null, toolCtx);
  await tool.execute("tc-update2", { action: "plan", op: "update", draft_id: "d1", summary: "New phase summarized." }, null, null, toolCtx);
  await pi.emit("agent_settled", { type: "agent_settled" }, toolCtx);
  await pi.commands.get("midcompact").handler("commit", commandCtx);

  const latestStateEntry = [...entries].reverse().find(e => e.customType === "midcompact-state");
  assert.ok(latestStateEntry);
  assert.equal(latestStateEntry.data.blocks.length, 2);
  assert.equal(latestStateEntry.data.blocks[0].id, "c0001");
  assert.equal(latestStateEntry.data.blocks[1].id, "c0002");
});

test("locate bounds ambiguous searches and full detail requires a direct ref", async () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    type: "message",
    id: `e${index + 1}`,
    parentId: index === 0 ? null : `e${index}`,
    message: user(`repeated landmark ${index}`, index + 1),
  }));
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [0]; // Agent direct (first option)
  await pi.commands.get("midcompact").handler("start", commandCtx);
  const tool = pi.tools.get("midcompact");

  const inspected = await tool.execute("tc-spans", {
    action: "inspect",
    spans: [{ start: "a0001", end: "a0003" }, { start: "a0002", end: "a0005" }],
  }, null, null, toolCtx);
  assert.match(inspected.content[0].text, /Candidate span inspection: 2 requested/);
  assert.match(inspected.content[0].text, /% of anchor factual content/);

  const matches = await tool.execute("tc-locate", { action: "locate", pattern: "repeated landmark", limit: 20 }, null, null, toolCtx);
  assert.match(matches.content[0].text, /Showing 3 of 5 matches/);
  const fullSearch = await tool.execute("tc-locate-full", { action: "locate", pattern: "repeated", detail: "full" }, null, null, toolCtx);
  assert.match(fullSearch.content[0].text, /Error: locate detail=full requires one direct atom ref/);
  const mixed = await tool.execute("tc-locate-mixed", { action: "locate", ref: "a0001", pattern: "repeated" }, null, null, toolCtx);
  assert.match(mixed.content[0].text, /Error: locate accepts either one direct ref or search filters/);
});

test("plan mutations return only the changed range or removed id", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("range one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: user("range two", 2) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [0]; // Agent direct (first option)
  await pi.commands.get("midcompact").handler("start", commandCtx);
  const tool = pi.tools.get("midcompact");
  await tool.execute("tc-add-1", { action: "plan", op: "add", start: "a0001", end: "a0001", summary: "one" }, null, null, toolCtx);
  await tool.execute("tc-add-2", { action: "plan", op: "add", start: "a0002", end: "a0002", summary: "two" }, null, null, toolCtx);

  const updated = await tool.execute("tc-update", { action: "plan", op: "update", draft_id: "d1", summary: "one updated" }, null, null, toolCtx);
  assert.match(updated.content[0].text, /updated d1/);
  assert.match(updated.content[0].text, /summary: one updated/);
  assert.doesNotMatch(updated.content[0].text, /d2:/);
  assert.doesNotMatch(updated.content[0].text, /Context awareness/);

  const removed = await tool.execute("tc-remove", { action: "plan", op: "remove", draft_id: "d1" }, null, null, toolCtx);
  assert.match(removed.content[0].text, /removed d1 · 1 range/);
  assert.doesNotMatch(removed.content[0].text, /d2:/);
  assert.doesNotMatch(removed.content[0].text, /Context awareness/);
});
