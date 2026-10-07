import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { setupRuntime, setOpenReviewWebBrowser, user, assistant } from "./runtime-helpers.mjs";

async function openWorkbench(t, surface = "review") {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const runtime = setupRuntime(entries);
  const { pi, toolCtx, commandCtx } = runtime;
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [0];
  await pi.commands.get("midcompact:start").handler("", commandCtx);
  const tool = pi.tools.get("midcompact");
  await tool.execute("add", { request: { action: "plan_add", start: "a0001", end: "a0002", summary: "Saved summary." } }, null, null, toolCtx);
  await pi.emit("agent_settled", {}, toolCtx);

  let ready;
  const readyUrl = new Promise(resolve => { ready = resolve; });
  setOpenReviewWebBrowser(ready);
  const pending = pi.commands.get(`midcompact:${surface}`).handler("webui", commandCtx);
  t.after(async () => {
    commandCtx.ui.confirmResult = true;
    await pi.commands.get("midcompact:close-webui").handler("", commandCtx);
    await pending;
    setOpenReviewWebBrowser(undefined);
  });
  const url = await readyUrl;
  return { ...runtime, tool, url, pending, entries };
}

for (const surface of ["review", "select"]) {
  test(`close-webui closes ${surface}, preserves the saved plan, and permits Agent edits`, { timeout: 3000 }, async t => {
    const { pi, toolCtx, commandCtx, tool, url, pending, entries } = await openWorkbench(t, surface);
    // Pi's idle input loop waits for slash commands, so opening must return
    // while the workbench still holds the lock; otherwise recovery is queued.
    await pending;
    const stream = await fetch(new URL("/api/liveness", url));
    const before = structuredClone(entries);
    const blocked = await tool.execute("blocked", { request: { action: "plan_update", range_id: "d1", summary: "Agent edit." } }, null, null, toolCtx);
    assert.match(blocked.content[0].text, /planning lock|UI.*editing/i);

    await pi.commands.get("midcompact:close-webui").handler("", commandCtx);
    await pending;
    await stream.body.cancel().catch(() => {});
    assert.deepEqual(entries, before, "closing must not append or alter persisted state");
    assert.match(toolCtx.ui.confirmations.at(-1).message, /Unsaved browser edits will not be saved/);
    assert.match(toolCtx.ui.messages.at(-1).text, /WebUI closed.*plan and transaction are unchanged/);
    assert.doesNotMatch(toolCtx.ui.statuses.get("midcompact"), /UI editing/);
    await assert.rejects(fetch(new URL("/api/state", url)));
    const changed = await tool.execute("changed", { request: { action: "plan_update", range_id: "d1", summary: "Agent edit." } }, null, null, toolCtx);
    assert.match(changed.content[0].text, /Agent edit\./);
  });
}

test("close-webui cancellation leaves the page available and the plan locked", { timeout: 3000 }, async t => {
  const { pi, toolCtx, commandCtx, tool, url } = await openWorkbench(t);
  commandCtx.ui.confirmResult = false;
  await pi.commands.get("midcompact:close-webui").handler("", commandCtx);
  assert.equal((await fetch(new URL("/api/state", url))).status, 200);
  const blocked = await tool.execute("blocked", { request: { action: "plan_update", range_id: "d1", summary: "Not saved." } }, null, null, toolCtx);
  assert.match(blocked.content[0].text, /planning lock|UI.*editing/i);

  // A second UI must not steal ownership before the old UI's finally runs.
  await pi.commands.get("midcompact:select").handler("webui", commandCtx);
  assert.match(toolCtx.ui.messages.at(-1).text, /planning UI is already open.*close-webui/);
});

test("close-webui with no WebUI leaves Agent and unrelated UI locks alone", async () => {
  const { pi, toolCtx, commandCtx } = setupRuntime([
    { type: "message", id: "e1", parentId: null, message: user("current work", 1) },
  ]);
  await pi.commands.get("midcompact:close-webui").handler("", commandCtx);
  assert.match(toolCtx.ui.messages.at(-1).text, /No midcompact WebUI.*No planning lock was changed/);
  assert.equal(toolCtx.ui.confirmations.length, 0);

  assert.equal(pi.midcompactPlanningLock.tryAcquireUi(), true);
  await pi.commands.get("midcompact:close-webui").handler("", commandCtx);
  assert.equal(pi.midcompactPlanningLock.getOwner(), "ui");
  pi.midcompactPlanningLock.releaseUi();
  toolCtx.ui.selectResults = [0];
  await pi.commands.get("midcompact:start").handler("", commandCtx);
  await pi.emit("agent_start", {}, toolCtx);
  await pi.commands.get("midcompact:close-webui").handler("", commandCtx);
  assert.equal(pi.midcompactPlanningLock.getOwner(), "agent");
});

test("close-webui recovers an already-closing server with an incomplete edit request", { timeout: 3000 }, async t => {
  const { pi, toolCtx, commandCtx, tool, url, pending, entries } = await openWorkbench(t);
  const before = structuredClone(entries);
  const socket = net.connect(Number(new URL(url).port), "127.0.0.1");
  t.after(() => socket.destroy());
  socket.on("error", () => {});
  await once(socket, "connect");
  const response = once(socket, "data");
  const body = JSON.stringify({ value: "Stale browser edit." });
  socket.write(`POST /api/range/d1/edit-summary HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${Buffer.byteLength(body)}\r\nExpect: 100-continue\r\n\r\n${body.slice(0, 5)}`);
  assert.match((await response)[0].toString(), /100 Continue/);

  await pending;
  const closeResponse = await fetch(new URL("/api/close", url), { method: "POST" });
  assert.equal(closeResponse.status, 200);
  await closeResponse.text();
  assert.equal(pi.midcompactPlanningLock.getOwner(), "ui", "incomplete edit keeps graceful shutdown pending");
  await pi.commands.get("midcompact:close-webui").handler("", commandCtx);
  assert.equal(pi.midcompactPlanningLock.getOwner(), undefined);
  assert.deepEqual(entries, before, "the pending browser edit must not be applied");
  const changed = await tool.execute("changed", { request: { action: "plan_update", range_id: "d1", summary: "Recovered." } }, null, null, toolCtx);
  assert.match(changed.content[0].text, /Recovered\./);
});

test("close-webui without interactive UI warns and still closes the server", { timeout: 3000 }, async t => {
  const { pi, toolCtx, commandCtx, url, pending } = await openWorkbench(t);
  commandCtx.hasUI = false;
  await pi.commands.get("midcompact:close-webui").handler("", commandCtx);
  await pending;
  assert.equal(toolCtx.ui.confirmations.length, 0);
  assert.ok(toolCtx.ui.messages.some(m => m.level === "warning" && /Unsaved browser edits/.test(m.text)));
  await assert.rejects(fetch(new URL("/api/state", url)));
});

test("closing one session's WebUI does not close another session's server", { timeout: 3000 }, async t => {
  const first = await openWorkbench(t);
  const second = await openWorkbench(t);
  await first.pi.commands.get("midcompact:close-webui").handler("", first.commandCtx);
  assert.equal((await fetch(new URL("/api/state", second.url))).status, 200);
  assert.equal(second.pi.midcompactPlanningLock.getOwner(), "ui");
});

test("tree navigation closes the old WebUI before restoring branch state", { timeout: 3000 }, async t => {
  const { tool, pi, toolCtx, commandCtx, url, pending, entries } = await openWorkbench(t);
  await pending;
  const before = structuredClone(entries);
  await commandCtx.navigateTree("e2", { summarize: false });
  await assert.rejects(fetch(new URL("/api/state", url)));
  assert.deepEqual(entries, before);
  const show = await tool.execute("show", { request: { action: "plan_show" } }, null, null, toolCtx);
  assert.match(show.content[0].text, /No active midcompact transaction/);
  assert.equal(pi.midcompactPlanningLock.getOwner(), undefined);
});

test("session shutdown closes its registered WebUI without a confirmation dialog", { timeout: 3000 }, async t => {
  const { pi, toolCtx, url, pending } = await openWorkbench(t);
  await pi.emit("session_shutdown", {}, toolCtx);
  await pending;
  assert.equal(toolCtx.ui.confirmations.length, 0);
  await assert.rejects(fetch(new URL("/api/state", url)));
});
