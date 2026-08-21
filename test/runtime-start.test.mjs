import test from "node:test";
import assert from "node:assert/strict";
import { setupRuntime, user } from "./runtime-helpers.mjs";

test("/midcompact start [instructions] no longer accepts --user/--agent flags", async () => {
  const entries = [{ type: "message", id: "e1", parentId: null, message: user("current work", 1) }];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  // "--user" is treated as instructions text, not a mode flag.
  await pi.commands.get("midcompact").handler("start --user", commandCtx);
  assert.match(pi.sentUserMessages.at(-1), /User focus: --user/);
});

test("/midcompact start chooser forwards an initial focus (Agent-first)", async () => {
  const entries = [{ type: "message", id: "e1", parentId: null, message: user("current work", 1) }];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  await pi.commands.get("midcompact").handler("start Compress old exploration only", commandCtx);

  assert.equal(toolCtx.ui.confirmations.length, 0);
  assert.match(toolCtx.ui.reviewFrames[0].join("\n"), /Drop.*Agent direct.*User manual/s);
  assert.match(pi.sentUserMessages.at(-1), /User focus: Compress old exploration only/);
  assert.match(pi.sentUserMessages.at(-1), /inspect/);
  assert.match(pi.sentUserMessages.at(-1), /plan show/);
  assert.equal(entries.some(e => e.customType === "midcompact-transaction"), true);
  assert.equal(entries.some(e => e.customType === "midcompact-selection"), false);
});

test("/midcompact start cancellation leaves the session at its anchor", async () => {
  const entries = [{ type: "message", id: "e1", parentId: null, message: user("current work", 1) }];
  const { sm, pi, toolCtx, commandCtx } = setupRuntime(entries);
  toolCtx.ui.customInputs = ["1"];

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  await pi.commands.get("midcompact").handler("start", commandCtx);

  assert.equal(sm.leafId, "e1");
  assert.equal(entries.some(e => e.customType === "midcompact-transaction"), false);
  assert.equal(pi.sentUserMessages.length, 0);
  assert.match(toolCtx.ui.messages.at(-1).text, /cancelled/);
});
