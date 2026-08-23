import test from "node:test";
import assert from "node:assert/strict";
import { makeBaseCtx, makeCommandCtx, setupRuntime, user, assistant } from "./runtime-helpers.mjs";

test("commit rejects a pending (empty) summary", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  const tool = pi.tools.get("midcompact");
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [1]; // Agent direct
  await pi.commands.get("midcompact").handler("start", commandCtx);
  // Add a range but leave its summary empty (pending).
  await tool.execute("tc-add", { action: "plan", op: "add", start: "a0001", end: "a0002" }, null, null, toolCtx);
  await pi.emit("agent_settled", { type: "agent_settled" }, toolCtx);
  await pi.commands.get("midcompact").handler("commit", commandCtx);
  assert.match(toolCtx.ui.messages.at(-1).text, /empty.*summary|pending.*summary|commit rejected/i);
});

test("reload restores transaction startMode and draft", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { sm, pi, toolCtx, commandCtx } = setupRuntime(entries);
  const tool = pi.tools.get("midcompact");
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [2]; // User manual
  toolCtx.ui.customInputs = ["s"];
  await pi.commands.get("midcompact").handler("start", commandCtx);
  await tool.execute("tc-preadd", { action: "plan", op: "add", start: "a0001", end: "a0002" }, null, null, toolCtx);

  // Simulate a reload on a fresh context.
  const freshCtx = makeBaseCtx(sm);
  const freshCommandCtx = makeCommandCtx(pi, sm, freshCtx);
  await pi.emit("session_start", { reason: "reload" }, freshCtx);
  await pi.commands.get("midcompact").handler("status", freshCommandCtx);
  const statusNotify = freshCtx.ui.messages.at(-1).text;
  assert.match(statusNotify, /user-first/);
  assert.match(statusNotify, /d1/);
});
