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
    this.counter = 100;
  }
  on(name, handler) {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }
  registerCommand(name, def) { this.commands.set(name, def); }
  registerTool(def) { this.tools.set(def.name, def); }
  appendEntry(customType, data) {
    const id = `x${++this.counter}`;
    this.sm.entries.push({ type: "custom", id, parentId: this.sm.leafId, customType, data });
    this.sm.leafId = id;
    return id;
  }
  async sendUserMessage(content) {
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
    ui: {
      messages: [],
      notify(text, level) { this.messages.push({ text, level }); },
    },
    isIdle() { return true; },
    abort() { this.aborted = true; },
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

test("/midcompact transaction commits state at anchor and tree rollback restores raw history", async () => {
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
  await pi.emit("session_start", { reason: "startup" }, toolCtx);

  await pi.commands.get("midcompact").handler("", commandCtx);
  assert.notEqual(sm.leafId, "e3");
  assert.equal(sm.getBranch().some(e => e.customType === "midcompact-transaction"), true);

  const tool = pi.tools.get("midcompact");
  const located = await tool.execute("tc1", { action: "locate", pattern: "old exploration", source: "assistant" }, null, null, toolCtx);
  assert.match(located.content[0].text, /a0002/);

  const planned = await tool.execute("tc2", {
    action: "plan", op: "add", start: "a0001", end: "a0002", summary: "Old requirement and exploration summarized."
  }, null, null, toolCtx);
  assert.match(planned.content[0].text, /d1:/);

  assert.equal("navigateTree" in toolCtx, false, "tool context must not expose command-only session navigation");
  await pi.commands.get("midcompact").handler("commit", commandCtx);

  const committedLeaf = sm.leafId;
  const committedEntry = entries.find(e => e.id === committedLeaf);
  assert.equal(committedEntry.customType, "midcompact-state");
  assert.equal(committedEntry.parentId, "e3");
  assert.equal(sm.getBranch().some(e => e.customType === "midcompact-transaction"), false);

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

  const search = await tool.execute("tc4", { action: "recall", pattern: "requirement" }, null, null, toolCtx);
  assert.match(search.content[0].text, /c0001/);
  const recalled = await tool.execute("tc5", { action: "recall", ref: "c0001", detail: "full" }, null, null, toolCtx);
  assert.match(recalled.content[0].text, /old requirement/);
  assert.match(recalled.content[0].text, /old exploration/);

  const afterRecall = await pi.emit("context", { messages: structuredClone(rawMessages) }, toolCtx);
  assert.equal(afterRecall.messages[0].customType, "midcompact-summary");
});
