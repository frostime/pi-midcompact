import test from "node:test";
import assert from "node:assert/strict";
import { setupRuntime, user, assistant } from "./runtime-helpers.mjs";

test("User-first start sends a waiting prompt, then opens Selection without further Agent work", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { sm, pi, toolCtx, commandCtx } = setupRuntime(entries);

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [1, 1]; // User manual, then TUI Selection
  toolCtx.ui.customInputs = ["s"];
  await pi.commands.get("midcompact:start").handler("", commandCtx);

  assert.equal(pi.sentUserMessages.length, 1, "User-first sends the shared setup prompt once");
  assert.match(pi.sentUserMessages[0], /FINAL STATE: USER MANUAL/);
  assert.match(pi.sentUserMessages[0], /Acknowledge with OK only/);
  assert.match(pi.sentUserMessages[0], /later request, read the `midcompact` skill before doing any planning work/i);
  const startHandoff = await pi.emit("before_agent_start", { prompt: pi.sentUserMessages[0] }, toolCtx);
  assert.equal(startHandoff, undefined, "the startup prompt already carries its own guidance");
  assert.equal(entries.some(e => e.customType === "midcompact-transaction"), true);
  assert.equal(entries.some(e => e.customType === "midcompact-selection"), false);
  assert.match(toolCtx.ui.messages.at(-1).text, /DraftPlan saved|tell the Agent/i);
  const txEntry = entries.find(e => e.customType === "midcompact-transaction");
  assert.equal(txEntry.data.startMode, "user");
});

test("User-first TUI selection writes pending ranges into the shared DraftPlan", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [1, 1]; // User manual, then TUI Selection
  toolCtx.ui.customInputs = [[" ", "s"]];

  await pi.commands.get("midcompact:start").handler("", commandCtx);

  const draftEntry = [...entries].reverse().find(entry => entry.customType === "midcompact-draft");
  assert.equal(draftEntry.data.ranges.length, 1);
  assert.equal(draftEntry.data.ranges[0].startRef, "a0001");
  assert.equal(draftEntry.data.ranges[0].endRef, "a0001");
  assert.equal(draftEntry.data.ranges[0].summary, "");
  assert.equal(pi.sentUserMessages.length, 1);

  toolCtx.ui.customInputs = ["s"];
  await pi.commands.get("midcompact:select").handler("tui", commandCtx);
  const selectionFrame = toolCtx.ui.reviewFrames.at(-1).join("\n");
  assert.match(selectionFrame, /Selected 1\/2 atoms \| 9\/24 chars \(37\.5% of anchor\) \| up to 37\.5% fewer anchor chars/);
});

test("User-first ESC closes without discarding the transaction, and select can reopen it", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [1, 1]; // User manual, then TUI Selection
  toolCtx.ui.customInputs = ["\x1b"];
  await pi.commands.get("midcompact:start").handler("", commandCtx);

  assert.equal(entries.some(entry => entry.customType === "midcompact-transaction"), true);
  assert.equal([...entries].reverse().find(entry => entry.customType === "midcompact-draft").data.ranges.length, 0);

  toolCtx.ui.customInputs = [[" ", "s"]];
  await pi.commands.get("midcompact:select").handler("tui", commandCtx);
  const draftEntry = [...entries].reverse().find(entry => entry.customType === "midcompact-draft");
  assert.equal(draftEntry.data.ranges.length, 1);
  assert.equal(pi.sentUserMessages.length, 1);
});

test("Agent discovers an existing user DraftPlan via plan show after handoff", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
    { type: "message", id: "e3", parentId: "e2", message: user("phase two", 3) },
    { type: "message", id: "e4", parentId: "e3", message: assistant("more work", 4) },
  ];
  const { sm, pi, toolCtx, commandCtx } = setupRuntime(entries);
  const tool = pi.tools.get("midcompact");

  // User-first start.
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [1, 1]; // User manual, then TUI Selection
  toolCtx.ui.customInputs = ["s"];
  await pi.commands.get("midcompact:start").handler("", commandCtx);

  // Simulate the user having pre-selected a range (written into DraftPlan by the
  // future Selection UI). Here we drive it through the Agent tool as a stand-in,
  // since the UI is not yet implemented.
  await tool.execute("tc-preadd", { request: { action: "plan_add", start: "a0001", end: "a0002" } }, null, null, toolCtx);

  await pi.emit("agent_settled", { type: "agent_settled" }, toolCtx);
  const handoff = await pi.emit("before_agent_start", { prompt: "continue the current midcompact draft" }, toolCtx);
  assert.match(handoff.message.content, /persisted plan/);
  assert.match(handoff.message.content, /read the `midcompact` skill first/i);
  assert.match(handoff.message.content, /plan.*show/);
  assert.match(handoff.message.content, /shared starting point/);
  assert.match(handoff.message.content, /preserve, refine, or extend/);
  assert.doesNotMatch(handoff.message.content, /initial proposal/);

  // User hands off; one read-only show reveals the selected landmarks and does
  // not persist a duplicate DraftPlan entry.
  await pi.emit("agent_start", { type: "agent_start" }, toolCtx);
  const draftEntriesBeforeShow = entries.filter(entry => entry.customType === "midcompact-draft").length;
  const shown = await tool.execute("tc-show", { request: { action: "plan_show" } }, null, null, toolCtx);
  assert.match(shown.content[0].text, /d1:/);
  assert.match(shown.content[0].text, /from: User: phase one/);
  assert.match(shown.content[0].text, /to: Assistant: old exploration/);
  assert.match(shown.content[0].text, /summary: <pending>/);
  assert.equal(entries.filter(entry => entry.customType === "midcompact-draft").length, draftEntriesBeforeShow);
});

test("Selection command validates arguments, offers an explicit chooser, and never defaults a surface", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [0]; // Agent direct
  await pi.commands.get("midcompact:start").handler("", commandCtx);

  const chooserCallsBefore = toolCtx.ui.selectCalls.length;
  await pi.commands.get("midcompact:select").handler("browser", commandCtx);
  assert.match(toolCtx.ui.messages.at(-1).text, /Usage: \/midcompact:select \[tui\|webui\]/);
  assert.equal(toolCtx.ui.selectCalls.length, chooserCallsBefore);
  assert.equal(toolCtx.ui.reviewFrames.length, 0);

  const draftEntriesBeforeCancel = entries.filter(entry => entry.customType === "midcompact-draft").length;
  toolCtx.ui.selectResults = [2]; // Cancel
  await pi.commands.get("midcompact:select").handler("", commandCtx);
  assert.deepEqual(toolCtx.ui.selectCalls.at(-1).options, [
    "Web UI — Recommended",
    "TUI — Built into Pi",
    "Cancel",
  ]);
  assert.equal(entries.filter(entry => entry.customType === "midcompact-draft").length, draftEntriesBeforeCancel);
  assert.equal(toolCtx.ui.reviewFrames.length, 0);
  assert.match(toolCtx.ui.messages.at(-1).text, /opening cancelled/i);

  commandCtx.hasUI = false;
  commandCtx.mode = "print";
  await pi.commands.get("midcompact:select").handler("", commandCtx);
  assert.match(toolCtx.ui.messages.at(-1).text, /No interactive UI.*specify.*select (?:tui|webui)/i);

  await pi.commands.get("midcompact:select").handler("tui", commandCtx);
  assert.match(toolCtx.ui.messages.at(-1).text, /TUI.*only available.*\/midcompact:select webui/i);

  commandCtx.hasUI = true;
  commandCtx.mode = "tui";
  toolCtx.ui.customInputs = ["\x1b"];
  await pi.commands.get("midcompact:select").handler(" TUI ", commandCtx);
  assert.equal(toolCtx.ui.selectCalls.length, chooserCallsBefore + 1, "an explicit surface must not open another chooser");
  assert.equal(toolCtx.ui.reviewFrames.length, 1);
});
