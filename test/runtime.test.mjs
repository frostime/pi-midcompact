import test from "node:test";
import assert from "node:assert/strict";
import extensionFactory from "../.test-dist/src/index.js";

class FakeSessionManager {
  constructor(entries, leafId) {
    this.entries = entries;
    this.leafId = leafId;
  }
  getEntries() { return this.entries; }
  getLeafId() { return this.leafId; }
  getBranch(leaf = this.leafId) {
    const byId = new Map(this.entries.map(e => [e.id, e]));
    const branch = [];
    let current = leaf ? byId.get(leaf) : undefined;
    while (current) {
      branch.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return branch.reverse();
  }
}

class FakePi {
  constructor(sm) {
    this.sm = sm;
    this.handlers = new Map();
    this.commands = new Map();
    this.tools = new Map();
    this.entryRenderers = new Map();
    this.labels = new Map();
    this.sentUserMessages = [];
    this.counter = 100;
  }
  on(name, handler) {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }
  registerCommand(name, def) { this.commands.set(name, def); }
  registerTool(def) { this.tools.set(def.name, def); }
  registerEntryRenderer(type, renderer) { this.entryRenderers.set(type, renderer); }
  appendEntry(customType, data) {
    const id = `x${++this.counter}`;
    this.sm.entries.push({ type: "custom", id, parentId: this.sm.leafId, customType, data });
    this.sm.leafId = id;
    return id;
  }
  setLabel(entryId, label) {
    this.labels.set(entryId, label);
    const id = `x${++this.counter}`;
    this.sm.entries.push({ type: "label_change", id, parentId: this.sm.leafId, targetId: entryId, label });
    this.sm.leafId = id;
  }
  async sendUserMessage(content) {
    this.sentUserMessages.push(content);
    const id = `x${++this.counter}`;
    this.sm.entries.push({ type: "message", id, parentId: this.sm.leafId, message: { role: "user", content, timestamp: this.counter } });
    this.sm.leafId = id;
  }
  async emit(name, event, ctx) {
    let result;
    for (const handler of this.handlers.get(name) ?? []) {
      const next = await handler(event, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  }
}

function makeBaseCtx(sm) {
  return {
    sessionManager: sm,
    mode: "tui",
    hasUI: true,
    ui: {
      messages: [],
      reviewFrames: [],
      confirmations: [],
      confirmResult: true,
      statuses: new Map(),
      theme: {
        fg(_color, text) { return text; },
        bg(_color, text) { return text; },
        bold(text) { return text; },
      },
      notify(text, level) { this.messages.push({ text, level }); },
      setStatus(key, text) { if (text === undefined) this.statuses.delete(key); else this.statuses.set(key, text); },
      async editor(_title, prefill) { return prefill; },
      async input(_title, placeholder) { return placeholder; },
      async confirm(title, message) {
        this.confirmations.push({ title, message });
        return this.confirmResult;
      },
      async custom(factory, _options) {
        let result = { action: "close" };
        const tui = { terminal: { rows: 30, columns: 120 }, requestRender() {} };
        const done = value => { result = value; };
        const component = await factory(tui, this.theme, {}, done);
        this.reviewFrames.push(component.render(120));
        component.handleInput?.("enter");
        return result;
      },
    },
    isIdle() { return true; },
    abort() { this.aborted = true; },
    getContextUsage() { return { tokens: 70000, contextWindow: 100000, percent: 70 }; },
  };
}

function makeCommandCtx(pi, sm, base) {
  return {
    ...base,
    async waitForIdle() {},
    async navigateTree(targetId, options) {
      const oldLeafId = sm.leafId;
      sm.leafId = targetId;
      await pi.emit("session_tree", { newLeafId: targetId, oldLeafId, fromExtension: true, options }, base);
      return { cancelled: false };
    },
  };
}


const user = (text, timestamp) => ({ role: "user", content: text, timestamp });
const assistant = (text, timestamp) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });

function setupRuntime(entries) {
  const sm = new FakeSessionManager(entries, entries.at(-1)?.id ?? null);
  const pi = new FakePi(sm);
  const toolCtx = makeBaseCtx(sm);
  const commandCtx = makeCommandCtx(pi, sm, toolCtx);
  extensionFactory(pi);
  return { sm, pi, toolCtx, commandCtx };
}

/** Drive the full Agent-propose workflow end-to-end via the tool surface. */
async function runAgentWorkflow(pi, toolCtx, commandCtx, { instructions } = {}) {
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  await pi.commands.get("midcompact").handler(`start ${instructions ?? ""}`.trim(), commandCtx);
  const tool = pi.tools.get("midcompact");

  // Agent must inspect first.
  const inspected = await tool.execute("tc-inspect", { action: "inspect" }, null, null, toolCtx);
  assert.match(inspected.content[0].text, /content chars/i);

  // Agent persists a candidate Selection (unconfirmed).
  const selected = await tool.execute("tc-select", {
    action: "select",
    spans: JSON.stringify([{ startRef: "a0001", endRef: "a0002" }]),
    keep_refs: JSON.stringify([]),
  }, null, null, toolCtx);
  assert.match(selected.content[0].text, /Selection persisted \(unconfirmed\)/);

  // Runtime guard: plan add is rejected before confirmation (selecting phase).
  const guarded = await tool.execute("tc-guard", {
    action: "plan", op: "add", start: "a0001", end: "a0002", summary: "x",
  }, null, null, toolCtx);
  assert.match(guarded.content[0].text, /selecting phase/);

  // User confirms.
  await pi.commands.get("midcompact").handler("confirm", commandCtx);

  // User confirms.
  await pi.commands.get("midcompact").handler("confirm", commandCtx);

  // After confirmation, ranges are already materialized (pending). Fill summaries via plan update.
  const draftState = await tool.execute("tc-after-confirm", { action: "plan", op: "show" }, null, null, toolCtx);
  const rangeIds = [...draftState.content[0].text.matchAll(/d\d+:/g)].map(m => m[0].replace(/:$/, ""));
  for (const id of rangeIds) {
    await tool.execute(`tc-fill-${id}`, { action: "plan", op: "update", draft_id: id, summary: `Summary for ${id}.` }, null, null, toolCtx);
  }
  const planned = await tool.execute("tc-show", { action: "plan", op: "show" }, null, null, toolCtx);
  assert.match(planned.content[0].text, /d1:/);
  // Agent-facing plan output echoes no summary text and no projected token claim.
  assert.doesNotMatch(planned.content[0].text, /Summary for d1\./);
  assert.doesNotMatch(planned.content[0].text, /projected if committed now/);
  assert.match(planned.content[0].text, /content chars/);
  assert.match(toolCtx.ui.statuses.get("midcompact"), /MC summarizing/);
  return tool;
}

test("/midcompact start confirms and forwards an initial focus", async () => {
  const entries = [{ type: "message", id: "e1", parentId: null, message: user("current work", 1) }];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  await pi.commands.get("midcompact").handler("start Compress old exploration only", commandCtx);

  assert.equal(toolCtx.ui.confirmations.length, 1);
  assert.match(pi.sentUserMessages.at(-1), /User focus: Compress old exploration only/);
  assert.match(pi.sentUserMessages.at(-1), /action="inspect"/);
  assert.equal(entries.some(e => e.customType === "midcompact-transaction"), true);
  assert.equal(entries.some(e => e.customType === "midcompact-selection"), true);
});

test("/midcompact start cancellation leaves the session at its anchor", async () => {
  const entries = [{ type: "message", id: "e1", parentId: null, message: user("current work", 1) }];
  const { sm, pi, toolCtx, commandCtx } = setupRuntime(entries);
  toolCtx.ui.confirmResult = false;

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  await pi.commands.get("midcompact").handler("start", commandCtx);

  assert.equal(sm.leafId, "e1");
  assert.equal(entries.some(e => e.customType === "midcompact-transaction"), false);
  assert.equal(pi.sentUserMessages.length, 0);
  assert.match(toolCtx.ui.messages.at(-1).text, /cancelled/);
});

test("/midcompact completes only the subcommand token", () => {
  const entries = [{ type: "message", id: "e1", parentId: null, message: user("current work", 1) }];
  const { pi } = setupRuntime(entries);
  const command = pi.commands.get("midcompact");

  assert.deepEqual(command.getArgumentCompletions("rev").map(item => item.value), ["review", "review-webui"]);
  assert.deepEqual(command.getArgumentCompletions("con").map(item => item.value), ["confirm"]);
  assert.equal(command.getArgumentCompletions("start "), null);
});

test("Agent propose workflow: inspect → select → confirm → plan → review → commit, then tree rollback restores raw history", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("old requirement", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
    { type: "message", id: "e3", parentId: "e2", message: user("current work", 3) },
  ];
  const sm = new FakeSessionManager(entries, "e3");
  const pi = new FakePi(sm);
  const toolCtx = makeBaseCtx(sm);
  const commandCtx = makeCommandCtx(pi, sm, toolCtx);
  extensionFactory(pi);

  const tool = await runAgentWorkflow(pi, toolCtx, commandCtx, { instructions: "Compress old exploration only" });

  // Review UI still maps ranges and KEEP holes.
  await pi.commands.get("midcompact").handler("review", commandCtx);
  assert.ok(toolCtx.ui.reviewFrames.length > 0);
  assert.match(toolCtx.ui.reviewFrames.at(-1).join("\n"), /Midcompact Review/);
  assert.match(toolCtx.ui.reviewFrames.at(-1).join("\n"), /d1/);
  assert.match(toolCtx.ui.reviewFrames.at(-1).join("\n"), /KEEP/);

  assert.equal("navigateTree" in toolCtx, false, "tool context must not expose command-only session navigation");
  await pi.commands.get("midcompact").handler("commit", commandCtx);

  const committedLeaf = sm.leafId; // setLabel appends a label-change entry after the state entry.
  const committedEntry = [...entries].reverse().find(e => e.customType === "midcompact-state");
  assert.ok(committedEntry);
  assert.equal(committedEntry.parentId, "e3");
  assert.equal(sm.getBranch().some(e => e.customType === "midcompact-transaction"), false);
  assert.equal(sm.getBranch().some(e => e.customType === "midcompact-selection"), false);
  assert.match(pi.labels.get(committedEntry.id), /^midcompact/);
  assert.equal(toolCtx.ui.statuses.has("midcompact"), false);
  assert.ok(pi.entryRenderers.has("midcompact-state"));
  assert.equal(committedEntry.data.lastCommit.anchorUsage.percent, 70);
  assert.equal(committedEntry.data.lastCommit.anchorUsage.contextWindow, 100000);
  // Commit stats carry factual char/image fields.
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

  const afterRecall = await pi.emit("context", { messages: structuredClone(rawMessages) }, toolCtx);
  assert.equal(afterRecall.messages[0].customType, "midcompact-summary");

  // A later transaction should retain c0001 and compress only newly accumulated raw history.
  const newUserId = `x${++pi.counter}`;
  entries.push({ type: "message", id: newUserId, parentId: sm.leafId, message: user("new phase request", pi.counter) });
  sm.leafId = newUserId;
  const newAssistantId = `x${++pi.counter}`;
  entries.push({ type: "message", id: newAssistantId, parentId: sm.leafId, message: assistant("new phase exploration", pi.counter) });
  sm.leafId = newAssistantId;

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  await pi.commands.get("midcompact").handler("start", commandCtx);
  const inspect2 = await tool.execute("tc-inspect2", { action: "inspect" }, null, null, toolCtx);
  assert.match(inspect2.content[0].text, /compressed.*protected|protected/);
  await tool.execute("tc-select2", {
    action: "select", spans: JSON.stringify([{ startRef: "a0003", endRef: "a0004" }]), keep_refs: JSON.stringify([]),
  }, null, null, toolCtx);
  await pi.commands.get("midcompact").handler("confirm", commandCtx);
  const draftState2 = await tool.execute("tc-after-confirm2", { action: "plan", op: "show" }, null, null, toolCtx);
  const rangeIds2 = [...draftState2.content[0].text.matchAll(/d\d+:/g)].map(m => m[0].replace(/:$/, ""));
  for (const id of rangeIds2) {
    await tool.execute(`tc-fill2-${id}`, { action: "plan", op: "update", draft_id: id, summary: "New phase summarized." }, null, null, toolCtx);
  }
  await pi.commands.get("midcompact").handler("commit", commandCtx);

  const latestStateEntry = [...entries].reverse().find(e => e.customType === "midcompact-state");
  assert.ok(latestStateEntry);
  assert.equal(latestStateEntry.data.blocks.length, 2);
  assert.equal(latestStateEntry.data.blocks[0].id, "c0001");
  assert.equal(latestStateEntry.data.blocks[1].id, "c0002");
});

test("User select workflow: start --user sends no Agent prompt until Selection is confirmed", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
    { type: "message", id: "e3", parentId: "e2", message: user("phase two", 3) },
    { type: "message", id: "e4", parentId: "e3", message: assistant("more work", 4) },
  ];
  const { sm, pi, toolCtx, commandCtx } = setupRuntime(entries);
  const tool = pi.tools.get("midcompact");

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  await pi.commands.get("midcompact").handler("start --user", commandCtx);
  // No Agent prompt yet.
  assert.equal(pi.sentUserMessages.length, 0);
  assert.match(toolCtx.ui.messages.at(-1).text, /User select mode/);

  // User builds a Selection spanning a KEEP hole.
  const selected = await tool.execute("tc-usel", {
    action: "select",
    spans: JSON.stringify([{ startRef: "a0001", endRef: "a0004" }]),
    keep_refs: JSON.stringify(["a0003"]),
  }, null, null, toolCtx);
  assert.match(selected.content[0].text, /Selection persisted \(unconfirmed\)/);

  // User select cannot edit a Selection after confirmation.
  await pi.commands.get("midcompact").handler("confirm", commandCtx);
  assert.ok(pi.sentUserMessages.length > 0, "summary prompt sent only after confirmation");
  // Confirmed materialized ranges exclude the KEEP atom.
  const showAfter = await tool.execute("tc-ushow", { action: "plan", op: "show" }, null, null, toolCtx);
  assert.match(showAfter.content[0].text, /a0001 → a0002/);
  assert.match(showAfter.content[0].text, /a0004 → a0004/);

  const reSelect = await tool.execute("tc-uredo", {
    action: "select", spans: JSON.stringify([{ startRef: "a0001", endRef: "a0001" }]), keep_refs: JSON.stringify([]),
  }, null, null, toolCtx);
  assert.match(reSelect.content[0].text, /already confirmed/);
});

test("commit rejects a pending (empty) summary", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  const tool = pi.tools.get("midcompact");
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  await pi.commands.get("midcompact").handler("start", commandCtx);
  await tool.execute("tc-sel", {
    action: "select", spans: JSON.stringify([{ startRef: "a0001", endRef: "a0002" }]), keep_refs: JSON.stringify([]),
  }, null, null, toolCtx);
  await pi.commands.get("midcompact").handler("confirm", commandCtx);
  // Confirmed ranges materialize with pending (empty) summaries; do not fill them.
  await pi.commands.get("midcompact").handler("commit", commandCtx);
  assert.match(toolCtx.ui.messages.at(-1).text, /empty.*summary|pending.*summary|commit rejected/i);
});

test("reload restores transaction mode, selection, and phase", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { sm, pi, toolCtx, commandCtx } = setupRuntime(entries);
  const tool = pi.tools.get("midcompact");
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  await pi.commands.get("midcompact").handler("start --user", commandCtx);
  await tool.execute("tc-sel", {
    action: "select", spans: JSON.stringify([{ startRef: "a0001", endRef: "a0002" }]), keep_refs: JSON.stringify([]),
  }, null, null, toolCtx);

  // Simulate a reload by emitting session_start again on a fresh tool context.
  const freshCtx = makeBaseCtx(sm);
  const freshCommandCtx = makeCommandCtx(pi, sm, freshCtx);
  await pi.emit("session_start", { reason: "reload" }, freshCtx);
  await pi.commands.get("midcompact").handler("status", freshCommandCtx);
  // Selection + phase restored: status notify reflects unconfirmed selection and selecting phase.
  const statusNotify = freshCtx.ui.messages.at(-1).text;
  assert.match(statusNotify, /unconfirmed/);
  assert.match(statusNotify, /selecting/);
});
