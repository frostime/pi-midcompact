import extensionFactory from "../.test-dist/src/index.js";

/** Test seam: keep web workbench suites from spawning a system browser. */
export { setOpenReviewWebBrowser } from "../.test-dist/src/index.js";

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
      // Message-dialog answers for select: a number selects options[n], a string
      // is the raw answer, and an empty queue means the client never answers.
      selectResults: [],
      selectCalls: [],
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
      async select(title, options, opts) {
        this.selectCalls.push({ title, options, opts });
        const next = this.selectResults.length ? this.selectResults.shift() : undefined;
        return typeof next === "number" ? options[next] : next;
      },
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

export { FakeSessionManager, FakePi, makeBaseCtx, makeCommandCtx, user, assistant, setupRuntime };
