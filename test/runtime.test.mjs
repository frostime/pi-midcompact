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
      customInputs: [],
      confirmations: [],
      // Sequence of confirm results: first answer chooses Agent/User first, etc.
      confirmSequence: [],
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
        if (this.confirmSequence.length > 0) return this.confirmSequence.shift();
        return this.confirmResult;
      },
      async custom(factory, _options) {
        let result = { action: "close" };
        const tui = { terminal: { rows: 30, columns: 120 }, requestRender() {} };
        const done = value => { result = value; };
        const component = await factory(tui, this.theme, {}, done);
        this.reviewFrames.push(component.render(120));
        const next = this.customInputs.length ? this.customInputs.shift() : "enter";
        const inputs = Array.isArray(next) ? next : [next];
        for (const input of inputs) component.handleInput?.(input);
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

/** Drive the Agent-first workflow end-to-end via the tool surface. */
async function runAgentFirstWorkflow(pi, toolCtx, commandCtx, { instructions } = {}) {
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  // Start chooser defaults to Agent direct.
  await pi.commands.get("midcompact").handler(`start ${instructions ?? ""}`.trim(), commandCtx);
  const tool = pi.tools.get("midcompact");

  // Agent inspects first.
  const inspected = await tool.execute("tc-inspect", { action: "inspect" }, null, null, toolCtx);
  assert.match(inspected.content[0].text, /content chars/i);

  // Agent adds a range with an empty (pending) summary — allowed without confirm/select.
  const added = await tool.execute("tc-add", {
    action: "plan", op: "add", start: "a0001", end: "a0002",
  }, null, null, toolCtx);
  assert.match(added.content[0].text, /d1:/);
  assert.match(added.content[0].text, /pending summary/);

  // Agent fills the summary via update.
  const updated = await tool.execute("tc-update", {
    action: "plan", op: "update", draft_id: "d1", summary: "Phase one summarized.",
  }, null, null, toolCtx);
  assert.match(updated.content[0].text, /summarized/);
  // Agent-facing plan output echoes no summary text and no projected token claim.
  assert.doesNotMatch(updated.content[0].text, /Phase one summarized\./);
  assert.doesNotMatch(updated.content[0].text, /projected if committed now/);
  assert.match(updated.content[0].text, /content chars/);
  assert.match(toolCtx.ui.statuses.get("midcompact"), /MC planning/);
  return tool;
}

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

test("/midcompact completes only the subcommand token", () => {
  const entries = [{ type: "message", id: "e1", parentId: null, message: user("current work", 1) }];
  const { pi } = setupRuntime(entries);
  const command = pi.commands.get("midcompact");

  assert.deepEqual(command.getArgumentCompletions("rev").map(item => item.value), ["review", "review-webui"]);
  assert.deepEqual(command.getArgumentCompletions("sel").map(item => item.value), ["select", "select-webui"]);
  assert.equal(command.getArgumentCompletions("start "), null);
});

test("Agent-first workflow: inspect → plan add (pending) → update → review → commit, then tree rollback restores raw history", async () => {
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
  toolCtx.ui.confirmSequence = [true, true];
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

test("User-first start sends a waiting prompt, then opens Selection without further Agent work", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { sm, pi, toolCtx, commandCtx } = setupRuntime(entries);

  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.customInputs = ["3", "s"];
  await pi.commands.get("midcompact").handler("start", commandCtx);

  assert.equal(pi.sentUserMessages.length, 1, "User-first sends the shared setup prompt once");
  assert.match(pi.sentUserMessages[0], /FINAL STATE: USER MANUAL/);
  assert.match(pi.sentUserMessages[0], /Acknowledge with OK only/);
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
  toolCtx.ui.customInputs = ["3", [" ", "s"]];

  await pi.commands.get("midcompact").handler("start", commandCtx);

  const draftEntry = [...entries].reverse().find(entry => entry.customType === "midcompact-draft");
  assert.equal(draftEntry.data.ranges.length, 1);
  assert.equal(draftEntry.data.ranges[0].startRef, "a0001");
  assert.equal(draftEntry.data.ranges[0].endRef, "a0001");
  assert.equal(draftEntry.data.ranges[0].summary, "");
  assert.equal(pi.sentUserMessages.length, 1);
});

test("User-first ESC closes without discarding the transaction, and select can reopen it", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.customInputs = ["3", "\x1b"];
  await pi.commands.get("midcompact").handler("start", commandCtx);

  assert.equal(entries.some(entry => entry.customType === "midcompact-transaction"), true);
  assert.equal([...entries].reverse().find(entry => entry.customType === "midcompact-draft").data.ranges.length, 0);

  toolCtx.ui.customInputs = [[" ", "s"]];
  await pi.commands.get("midcompact").handler("select", commandCtx);
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
  toolCtx.ui.customInputs = ["3", "s"];
  await pi.commands.get("midcompact").handler("start", commandCtx);

  // Simulate the user having pre-selected a range (written into DraftPlan by the
  // future Selection UI). Here we drive it through the Agent tool as a stand-in,
  // since the UI is not yet implemented.
  await tool.execute("tc-preadd", { action: "plan", op: "add", start: "a0001", end: "a0002" }, null, null, toolCtx);

  await pi.emit("agent_settled", { type: "agent_settled" }, toolCtx);
  const handoff = await pi.emit("before_agent_start", { prompt: "continue the current midcompact draft" }, toolCtx);
  assert.match(handoff.message.content, /persisted DraftPlan/);
  assert.match(handoff.message.content, /plan.*show/);

  // User hands off; Agent's first call is plan show and it sees the existing draft.
  await pi.emit("agent_start", { type: "agent_start" }, toolCtx);
  const shown = await tool.execute("tc-show", { action: "plan", op: "show" }, null, null, toolCtx);
  assert.match(shown.content[0].text, /d1:/);
  assert.match(shown.content[0].text, /pending summary/);
});

test("commit rejects a pending (empty) summary", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  const tool = pi.tools.get("midcompact");
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.confirmSequence = [true, true];
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
  toolCtx.ui.customInputs = ["3", "s"];
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

test("no select/confirm actions exist in the tool surface", () => {
  const { pi } = setupRuntime([{ type: "message", id: "e1", parentId: null, message: user("x", 1) }]);
  const tool = pi.tools.get("midcompact");
  // The mock StringEnum compiles to { kind: "string-enum", value: { values: [...] } }.
  const actionParam = tool.parameters;
  const json = JSON.stringify(actionParam);
  assert.doesNotMatch(json, /"select"/);
  assert.doesNotMatch(json, /"confirm"/);
  assert.match(json, /"inspect"/);
  assert.match(json, /"locate"/);
  assert.match(json, /"plan"/);
  assert.match(json, /"recall"/);
});

test("no /midcompact confirm command exists", () => {
  const { pi } = setupRuntime([{ type: "message", id: "e1", parentId: null, message: user("x", 1) }]);
  const command = pi.commands.get("midcompact");
  const completions = command.getArgumentCompletions("con") ?? [];
  assert.equal(completions.some(c => c.value === "confirm"), false);
});

// ---- Planning lock runtime tests ----

async function startAgentFirst(pi, toolCtx, commandCtx) {
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.confirmSequence = [true, true];
  await pi.commands.get("midcompact").handler("start", commandCtx);
  return pi.tools.get("midcompact");
}

test("planning lock: Agent holding the lock blocks UI acquire and notifies", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  const tool = await startAgentFirst(pi, toolCtx, commandCtx);
  // Agent plan mutation acquires the lock.
  await tool.execute("tc1", { action: "plan", op: "add", start: "a0001", end: "a0002" }, null, null, toolCtx);
  assert.equal(pi.midcompactPlanningLock.getOwner(), "agent");
  // UI acquire is rejected while the Agent holds the lock.
  assert.equal(pi.midcompactPlanningLock.tryAcquireUi(), false);
  assert.equal(pi.midcompactPlanningLock.getOwner(), "agent");
});

test("planning lock: agent_start blocks UI before the first tool action", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  await startAgentFirst(pi, toolCtx, commandCtx);

  await pi.emit("agent_start", { type: "agent_start" }, toolCtx);
  assert.equal(pi.midcompactPlanningLock.getOwner(), "agent");
  assert.equal(pi.midcompactPlanningLock.tryAcquireUi(), false);

  await pi.emit("agent_settled", { type: "agent_settled" }, toolCtx);
  assert.equal(pi.midcompactPlanningLock.tryAcquireUi(), true);
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
  assert.equal(pi.midcompactPlanningLock.getOwner(), "ui");
  // Agent plan mutation is rejected.
  const res = await tool.execute("tc1", { action: "plan", op: "add", start: "a0001", end: "a0002" }, null, null, toolCtx);
  assert.match(res.content[0].text, /blocked.*planning lock|UI.*editing/i);
  assert.match(toolCtx.ui.messages.at(-1).text, /UI is currently editing/i);
  // The DraftPlan is unchanged.
  const show = await tool.execute("tc2", { action: "plan", op: "show" }, null, null, toolCtx);
  assert.doesNotMatch(show.content[0].text, /d1:/);
});

test("planning lock: Agent turn end (agent_settled) releases the lock so UI can edit", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  const tool = await startAgentFirst(pi, toolCtx, commandCtx);
  await tool.execute("tc1", { action: "plan", op: "add", start: "a0001", end: "a0002" }, null, null, toolCtx);
  assert.equal(pi.midcompactPlanningLock.getOwner(), "agent");
  await pi.emit("agent_settled", { type: "agent_settled" }, toolCtx);
  assert.equal(pi.midcompactPlanningLock.getOwner(), undefined);
  assert.equal(pi.midcompactPlanningLock.tryAcquireUi(), true);
});

test("planning lock: UI close or disconnect releases the lock so Agent can edit again", async () => {
  const entries = [
    { type: "message", id: "e1", parentId: null, message: user("phase one", 1) },
    { type: "message", id: "e2", parentId: "e1", message: assistant("old exploration", 2) },
  ];
  const { pi, toolCtx, commandCtx } = setupRuntime(entries);
  const tool = await startAgentFirst(pi, toolCtx, commandCtx);
  pi.midcompactPlanningLock.tryAcquireUi();
  // Agent mutation blocked while UI edits.
  let res = await tool.execute("tc1", { action: "plan", op: "add", start: "a0001", end: "a0002" }, null, null, toolCtx);
  assert.match(res.content[0].text, /blocked/i);
  // UI abnormal disconnect -> release.
  pi.midcompactPlanningLock.releaseUi();
  assert.equal(pi.midcompactPlanningLock.getOwner(), undefined);
  // Agent can now mutate.
  res = await tool.execute("tc2", { action: "plan", op: "add", start: "a0001", end: "a0002" }, null, null, toolCtx);
  assert.match(res.content[0].text, /d1:/);
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
  assert.equal(pi.midcompactPlanningLock.getOwner(), "agent");
  // Simulate reload on a fresh context.
  const freshCtx = makeBaseCtx(sm);
  const freshCommandCtx = makeCommandCtx(pi, sm, freshCtx);
  await pi.emit("session_start", { reason: "reload" }, freshCtx);
  // Lock is gone; DraftPlan is restored.
  assert.equal(pi.midcompactPlanningLock.getOwner(), undefined);
  const show = await tool.execute("tc3", { action: "plan", op: "show" }, null, null, freshCtx);
  assert.match(show.content[0].text, /d1:/);
  assert.match(show.content[0].text, /summarized/);
});
