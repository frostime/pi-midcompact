import test from "node:test";
import assert from "node:assert/strict";
import { setOpenReviewWebBrowser, setupRuntime, user } from "./runtime-helpers.mjs";

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await predicate();
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
}

test("/midcompact start [instructions] no longer accepts --user/--agent flags", async () => {
  const entries = [{ type: "message", id: "e1", parentId: null, message: user("current work", 1) }];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  // "--user" is treated as instructions text, not a mode flag.
  toolCtx.ui.selectResults = [0]; // Agent direct (first option)
  await pi.commands.get("midcompact:start").handler("--user", commandCtx);
  assert.match(pi.sentUserMessages.at(-1), /User focus: --user/);
});

test("/midcompact start chooser forwards an initial focus (Agent-first)", async () => {
  const entries = [{ type: "message", id: "e1", parentId: null, message: user("current work", 1) }];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  toolCtx.ui.selectResults = [0]; // Agent direct (first option)

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  await pi.commands.get("midcompact:start").handler("Compress old exploration only", commandCtx);

  assert.equal(toolCtx.ui.confirmations.length, 0);
  assert.equal(toolCtx.ui.reviewFrames.length, 0, "start uses the standard select dialog, not a custom component");
  assert.equal(toolCtx.ui.selectCalls.length, 1);
  assert.match(toolCtx.ui.selectCalls[0].options.join(" "), /Agent direct.*User manual.*Drop/s);
  assert.equal(toolCtx.ui.selectCalls[0].opts, undefined, "TUI dialogs are not timed");
  assert.match(pi.sentUserMessages.at(-1), /User focus: Compress old exploration only/);
  assert.match(pi.sentUserMessages.at(-1), /inspect/);
  assert.match(pi.sentUserMessages.at(-1), /plan show/);
  assert.equal(entries.some(e => e.customType === "midcompact-transaction"), true);
  assert.equal(entries.some(e => e.customType === "midcompact-selection"), false);
});

test("/midcompact start cancellation leaves the session at its anchor", async () => {
  const entries = [{ type: "message", id: "e1", parentId: null, message: user("current work", 1) }];
  const { sm, pi, toolCtx, commandCtx } = setupRuntime(entries);
  toolCtx.ui.selectResults = [2]; // Drop (third option)

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  await pi.commands.get("midcompact:start").handler("", commandCtx);

  assert.equal(sm.leafId, "e1");
  assert.equal(entries.some(e => e.customType === "midcompact-transaction"), false);
  assert.equal(pi.sentUserMessages.length, 0);
  assert.match(toolCtx.ui.messages.at(-1).text, /cancelled/);
});

test("/midcompact start in RPC mode asks via message dialog and starts Agent direct", async () => {
  const entries = [{ type: "message", id: "e1", parentId: null, message: user("current work", 1) }];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  commandCtx.mode = "rpc";
  commandCtx.ui.selectResults = [0]; // Agent direct (first option)

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  await pi.commands.get("midcompact:start").handler("", commandCtx);

  // One message dialog carries the whole decision: no TUI custom component, no separate confirm.
  assert.equal(toolCtx.ui.reviewFrames.length, 0);
  assert.equal(toolCtx.ui.confirmations.length, 0);
  assert.equal(toolCtx.ui.selectCalls.length, 1);
  assert.match(toolCtx.ui.selectCalls[0].title, /freeze the current context as an anchor/);
  assert.equal(toolCtx.ui.selectCalls[0].options.length, 3);
  assert.match(toolCtx.ui.selectCalls[0].options.join(" "), /Agent direct.*User manual.*Drop/s);
  assert.equal(toolCtx.ui.selectCalls[0].opts.timeout, 120_000, "RPC dialog timeout must be exactly 120s");
  assert.match(pi.sentUserMessages.at(-1), /AGENT DIRECT/);
  assert.equal(entries.some(e => e.customType === "midcompact-transaction"), true);
});

test("/midcompact start in RPC mode cancels when the client never answers", async () => {
  const entries = [{ type: "message", id: "e1", parentId: null, message: user("current work", 1) }];
  const { sm, pi, toolCtx, commandCtx } = setupRuntime(entries);
  commandCtx.mode = "rpc";
  commandCtx.ui.selectResults = []; // no response (timeout / no dialog support)

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  await pi.commands.get("midcompact:start").handler("", commandCtx);

  assert.equal(sm.leafId, "e1");
  assert.equal(entries.some(e => e.customType === "midcompact-transaction"), false);
  assert.equal(pi.sentUserMessages.length, 0);
  assert.match(toolCtx.ui.messages.at(-1).text, /cancelled/);
});

test("/midcompact start in RPC mode flags an unrecognized dialog answer instead of silent cancel", async () => {
  const entries = [{ type: "message", id: "e1", parentId: null, message: user("current work", 1) }];
  const { sm, pi, toolCtx, commandCtx } = setupRuntime(entries);
  commandCtx.mode = "rpc";
  commandCtx.ui.selectResults = ["not-an-offered-option"]; // protocol mismatch

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  await pi.commands.get("midcompact:start").handler("", commandCtx);

  assert.equal(sm.leafId, "e1");
  assert.equal(entries.some(e => e.customType === "midcompact-transaction"), false);
  assert.equal(pi.sentUserMessages.length, 0);
  assert.match(toolCtx.ui.messages.at(-1).text, /unrecognized choice/);
  assert.equal(toolCtx.ui.messages.at(-1).level, "warning");
});

test("/midcompact start in RPC mode can pick User manual and opens the browser workbench", async (t) => {
  t.after(() => setOpenReviewWebBrowser(undefined));
  const entries = [{ type: "message", id: "e1", parentId: null, message: user("current work", 1) }];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  commandCtx.mode = "rpc";
  commandCtx.ui.selectResults = [1]; // User manual (second option)
  setOpenReviewWebBrowser(() => {}); // keep the test from spawning a system browser

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  const pending = pi.commands.get("midcompact:start").handler("", commandCtx);

  // User manual hands over to the local Selection workbench; close it through its API.
  const ready = await waitFor(() => {
    const message = toolCtx.ui.messages.find(m => /selection webui ready/.test(m.text));
    return message?.text.match(/http:\/\/127\.0\.0\.1:\d+\/\?view=selection/)?.[0];
  });
  await fetch(new URL("api/close", ready), { method: "POST" });
  await pending;

  assert.equal(toolCtx.ui.reviewFrames.length, 0);
  assert.equal(toolCtx.ui.selectCalls.length, 1);
  assert.match(pi.sentUserMessages.at(-1), /USER MANUAL/);
  assert.match(pi.sentUserMessages.at(-1), /Acknowledge with OK only/);
  const tx = entries.find(e => e.customType === "midcompact-transaction");
  assert.ok(tx, "transaction entry must exist");
  assert.equal(tx.data.startMode, "user");
});

test("/midcompact start without UI (json/print) defaults to Agent direct and never prompts", async () => {
  const entries = [{ type: "message", id: "e1", parentId: null, message: user("current work", 1) }];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  commandCtx.mode = "print";
  commandCtx.hasUI = false;

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  await pi.commands.get("midcompact:start").handler("", commandCtx);

  assert.equal(toolCtx.ui.reviewFrames.length, 0);
  assert.equal(toolCtx.ui.confirmations.length, 0);
  assert.equal(toolCtx.ui.selectCalls.length, 0);
  assert.match(pi.sentUserMessages.at(-1), /AGENT DIRECT/);
  assert.equal(entries.some(e => e.customType === "midcompact-transaction"), true);
  assert.equal(entries.find(e => e.customType === "midcompact-transaction").data.startMode, "agent");
});
