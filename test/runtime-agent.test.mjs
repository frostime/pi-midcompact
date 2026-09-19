import test from "node:test";
import assert from "node:assert/strict";
import { setupRuntime, user, assistant } from "./runtime-helpers.mjs";

/** Drive the Agent-first workflow end-to-end via the tool surface. */
async function runAgentFirstWorkflow(pi, toolCtx, commandCtx, { instructions } = {}) {
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [0]; // Agent direct (first option)
  await pi.commands.get("midcompact:start").handler((instructions ?? "").trim(), commandCtx);
  assert.match(pi.sentUserMessages.at(-1), /read the `midcompact` skill before doing any planning work/i);
  const tool = pi.tools.get("midcompact");

  // Agent inspects first.
  const inspected = await tool.execute("tc-inspect", { request: { action: "inspect" } }, null, null, toolCtx);
  assert.match(inspected.content[0].text, /content chars/i);

  // Agent adds a range with an empty (pending) summary — allowed without confirm/select.
  const added = await tool.execute("tc-add", {
    request: { action: "plan_add", start: "a0001", end: "a0002" },
  }, null, null, toolCtx);
  assert.match(added.content[0].text, /added d1/);
  assert.match(added.content[0].text, /pending summary/);
  assert.doesNotMatch(added.content[0].text, /Context awareness/);

  // Agent fills the summary via update.
  const updated = await tool.execute("tc-update", {
    request: { action: "plan_update", range_id: "d1", summary: "Phase one summarized." },
  }, null, null, toolCtx);
  assert.match(updated.content[0].text, /updated d1/);
  assert.match(updated.content[0].text, /summarized/);
  assert.match(updated.content[0].text, /summary: Phase one summarized\./);
  assert.doesNotMatch(updated.content[0].text, /Context awareness/);
  assert.doesNotMatch(updated.content[0].text, /projected if committed now/);
  assert.match(updated.content[0].text, /content chars/);

  // Explicit show owns full awareness and the complete current range list.
  const shown = await tool.execute("tc-show", { request: { action: "plan_show" } }, null, null, toolCtx);
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

  // Review UI still maps ranges and KEEP holes; no argument requires an explicit surface choice.
  toolCtx.ui.selectResults = [1]; // TUI Review
  await pi.commands.get("midcompact:review").handler("", commandCtx);
  assert.deepEqual(toolCtx.ui.selectCalls.at(-1).options, [
    "Web UI — Recommended",
    "TUI — Built into Pi",
    "Cancel",
  ]);
  assert.ok(toolCtx.ui.reviewFrames.length > 0);
  assert.match(toolCtx.ui.reviewFrames.at(-1).join("\n"), /Midcompact Review/);
  assert.match(toolCtx.ui.reviewFrames.at(-1).join("\n"), /d1/);
  assert.match(toolCtx.ui.reviewFrames.at(-1).join("\n"), /KEEP/);

  assert.equal("navigateTree" in toolCtx, false, "tool context must not expose command-only session navigation");
  await pi.commands.get("midcompact:commit").handler("", commandCtx);

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

  const search = await tool.execute("tc4", { request: { action: "recall_list" } }, null, null, toolCtx);
  assert.match(search.content[0].text, /c0001/);
  const recalled = await tool.execute("tc5", { request: { action: "recall_read", block: "c0001", detail: "full" } }, null, null, toolCtx);
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
  await pi.commands.get("midcompact:start").handler("", commandCtx);
  const inspect2 = await tool.execute("tc-inspect2", { request: { action: "inspect" } }, null, null, toolCtx);
  assert.match(inspect2.content[0].text, /compressed.*protected|protected/);
  await tool.execute("tc-add2", { request: { action: "plan_add", start: "a0003", end: "a0004" } }, null, null, toolCtx);
  await tool.execute("tc-update2", { request: { action: "plan_update", range_id: "d1", summary: "New phase summarized." } }, null, null, toolCtx);
  await pi.emit("agent_settled", { type: "agent_settled" }, toolCtx);
  await pi.commands.get("midcompact:commit").handler("", commandCtx);

  const latestStateEntry = [...entries].reverse().find(e => e.customType === "midcompact-state");
  assert.ok(latestStateEntry);
  assert.equal(latestStateEntry.data.blocks.length, 2);
  assert.equal(latestStateEntry.data.blocks[0].id, "c0001");
  assert.equal(latestStateEntry.data.blocks[1].id, "c0002");
});

test("measure, locate_ref, and locate_search: bounded outputs and per-branch field rejection", async () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    type: "message",
    id: `e${index + 1}`,
    parentId: index === 0 ? null : `e${index}`,
    message: user(`repeated landmark ${index}`, index + 1),
  }));
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [0]; // Agent direct (first option)
  await pi.commands.get("midcompact:start").handler("", commandCtx);
  const tool = pi.tools.get("midcompact");

  const measured = await tool.execute("tc-measure", {
    request: {
      action: "measure",
      candidates: [{ start: "a0001", end: "a0003" }, { start: "a0002", end: "a0005" }],
    },
  }, null, null, toolCtx);
  assert.match(measured.content[0].text, /Candidate span inspection: 2 requested/);
  assert.match(measured.content[0].text, /% of anchor factual content/);

  const emptyMeasure = await tool.execute("tc-measure-empty", { request: { action: "measure", candidates: [] } }, null, null, toolCtx);
  assert.match(emptyMeasure.content[0].text, /Error: measure requires at least one start\/end candidate/);

  const matches = await tool.execute("tc-locate", { request: { action: "locate_search", pattern: "repeated landmark", limit: 20 } }, null, null, toolCtx);
  assert.match(matches.content[0].text, /Showing 3 of 5 matches/);
  const noFilter = await tool.execute("tc-locate-nofilter", { request: { action: "locate_search" } }, null, null, toolCtx);
  assert.match(noFilter.content[0].text, /Error: locate_search requires at least one filter: pattern, tool_name, or source/);
  const searchWithDetail = await tool.execute("tc-locate-detail", { request: { action: "locate_search", pattern: "repeated", detail: "full" } }, null, null, toolCtx);
  assert.match(searchWithDetail.content[0].text, /Error: locate_search does not accept: detail/);
  const refWithFilter = await tool.execute("tc-locate-mixed", { request: { action: "locate_ref", ref: "a0001", pattern: "repeated" } }, null, null, toolCtx);
  assert.match(refWithFilter.content[0].text, /Error: locate_ref does not accept: pattern/);
  const refFound = await tool.execute("tc-locate-ref", { request: { action: "locate_ref", ref: "a0001", detail: "full" } }, null, null, toolCtx);
  assert.match(refFound.content[0].text, /a0001 \| position 1/);
});

test("runtime legality rules: plan_read unknown range, plan_update without patch fields, extra-field backstop", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("range one", 1) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [0]; // Agent direct (first option)
  await pi.commands.get("midcompact:start").handler("", commandCtx);
  const tool = pi.tools.get("midcompact");
  await tool.execute("tc-add", { request: { action: "plan_add", start: "a0001", end: "a0001", summary: "one" } }, null, null, toolCtx);

  const unknownRange = await tool.execute("tc-read-unknown", { request: { action: "plan_read", range_id: "d99" } }, null, null, toolCtx);
  assert.match(unknownRange.content[0].text, /Error: Unknown plan range d99/);
  const knownRange = await tool.execute("tc-read-known", { request: { action: "plan_read", range_id: "d1" } }, null, null, toolCtx);
  assert.match(knownRange.content[0].text, /summary: one/);

  const bareUpdate = await tool.execute("tc-update-bare", { request: { action: "plan_update", range_id: "d1" } }, null, null, toolCtx);
  assert.match(bareUpdate.content[0].text, /Error: plan_update requires summary and\/or topic; boundaries change via plan_remove \+ plan_add/);
  const updateWithBoundary = await tool.execute("tc-update-boundary", { request: { action: "plan_update", range_id: "d1", start: "a0001", summary: "kept" } }, null, null, toolCtx);
  assert.match(updateWithBoundary.content[0].text, /Error: plan_update does not accept: start/);

  const showWithExtra = await tool.execute("tc-show-extra", { request: { action: "plan_show", range_id: "d1" } }, null, null, toolCtx);
  assert.match(showWithExtra.content[0].text, /Error: plan_show does not accept: range_id/);
});

test("plan mutations return only the changed range or removed id", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("range one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: user("range two", 2) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [0]; // Agent direct (first option)
  await pi.commands.get("midcompact:start").handler("", commandCtx);
  const tool = pi.tools.get("midcompact");
  await tool.execute("tc-add-1", { request: { action: "plan_add", start: "a0001", end: "a0001", summary: "one" } }, null, null, toolCtx);
  await tool.execute("tc-add-2", { request: { action: "plan_add", start: "a0002", end: "a0002", summary: "two" } }, null, null, toolCtx);

  const updated = await tool.execute("tc-update", { request: { action: "plan_update", range_id: "d1", summary: "one updated" } }, null, null, toolCtx);
  assert.match(updated.content[0].text, /updated d1/);
  assert.match(updated.content[0].text, /summary: one updated/);
  assert.doesNotMatch(updated.content[0].text, /d2:/);
  assert.doesNotMatch(updated.content[0].text, /Context awareness/);

  const removed = await tool.execute("tc-remove", { request: { action: "plan_remove", range_id: "d1" } }, null, null, toolCtx);
  assert.match(removed.content[0].text, /removed d1 · 1 range/);
  assert.doesNotMatch(removed.content[0].text, /d2:/);
  assert.doesNotMatch(removed.content[0].text, /Context awareness/);
});
