import test from "node:test";
import assert from "node:assert/strict";

const ROOT = new URL("../.test-dist/src/", import.meta.url);
const atomsMod = await import(new URL("atoms.js", ROOT));
const planMod = await import(new URL("plan.js", ROOT));
const projectionMod = await import(new URL("projection.js", ROOT));
const stateMod = await import(new URL("state.js", ROOT));

const { buildAtoms, locateAtoms } = atomsMod;
const { addDraftRange, emptyDraft } = planMod;
const { projectMessages } = projectionMod;
const { restoreCompressionState, STATE_ENTRY } = stateMod;

function entry(id, message, parentId = null) {
  return { type: "message", id, parentId, message };
}

const user = (text, timestamp) => ({ role: "user", content: text, timestamp });
const assistant = (content, timestamp) => ({ role: "assistant", content, timestamp });
const result = (id, toolName, text, timestamp) => ({ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], timestamp });

test("atomizer keeps a multi-tool assistant exchange closed", () => {
  const messages = [
    user("start", 1),
    assistant([
      { type: "text", text: "checking" },
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "t2", name: "bash", arguments: { command: "test" } },
    ], 2),
    result("t1", "read", "A", 3),
    result("t2", "bash", "ok", 4),
    assistant([{ type: "text", text: "done" }], 5),
  ];
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  assert.equal(atoms.length, 3);
  assert.equal(atoms[1].kind, "tool_exchange");
  assert.equal(atoms[1].messages.length, 3);
  assert.equal(atoms[1].protocolClosed, true);
  assert.equal(atoms[1].compressible, true);
  assert.deepEqual(atoms[1].toolNames.sort(), ["bash", "read"]);
});

test("orphan tool result is protected", () => {
  const messages = [result("missing", "read", "x", 1)];
  const atoms = buildAtoms(messages, [entry("e1", messages[0])]);
  assert.equal(atoms[0].kind, "orphan_tool_result");
  assert.equal(atoms[0].compressible, false);
});

test("locator returns semantic matches without permanent message ids", () => {
  const messages = [user("do auth", 1), assistant([{ type: "text", text: "Redis is not allowed" }], 2)];
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  const matches = locateAtoms(atoms, { pattern: "redis", source: "assistant" });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].ref, "a0002");
});

test("draft range can compress multiple atoms and rejects overlap", () => {
  const messages = [user("one", 1), assistant([{ type: "text", text: "two" }], 2), user("three", 3)];
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  let draft = emptyDraft("tx1");
  draft = addDraftRange(draft, atoms, { start: "a0001", end: "a0002", summary: "one-two" });
  assert.equal(draft.ranges.length, 1);
  assert.throws(() => addDraftRange(draft, atoms, { start: "a0002", end: "a0003", summary: "overlap" }), /overlaps/);
});

test("projection replaces only exact persisted message sequence", () => {
  const messages = [user("keep", 1), user("compress me", 2), assistant([{ type: "text", text: "old work" }], 3), user("recent", 4)];
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  const draft = addDraftRange(emptyDraft("tx"), atoms, { start: "a0002", end: "a0003", summary: "old work summarized" });
  const range = draft.ranges[0];
  const state = {
    version: 1,
    createdAt: new Date().toISOString(),
    blocks: [{
      id: "c0001",
      summary: range.summary,
      entryIds: range.entryIds,
      messageKeys: range.messageKeys,
      createdAt: new Date().toISOString(),
      originalApproxTokens: range.originalApproxTokens,
      compressedApproxTokens: range.compressedApproxTokens,
    }],
  };
  const projected = projectMessages(messages, state);
  assert.equal(projected.length, 3);
  assert.equal(projected[0].content, "keep");
  assert.equal(projected[1].customType, "midcompact-summary");
  assert.equal(projected[2].content, "recent");
});

test("state restoration is branch-local", () => {
  const state = { version: 1, createdAt: "x", blocks: [] };
  const beforeBranch = [{ type: "message", id: "t30", message: user("t30", 30) }];
  const afterBranch = [...beforeBranch, { type: "custom", id: "s1", customType: STATE_ENTRY, data: state }];
  assert.equal(restoreCompressionState(beforeBranch), undefined);
  assert.deepEqual(restoreCompressionState(afterBranch), state);
});

test("multiple compressed ranges preserve raw holes between them", () => {
  const messages = [
    user("old phase A", 1),
    assistant([{ type: "text", text: "noise A" }], 2),
    user("critical constraint: keep API compatible", 3),
    assistant([{ type: "text", text: "noise B" }], 4),
    user("current work", 5),
  ];
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  let draft = emptyDraft("tx");
  draft = addDraftRange(draft, atoms, { start: "a0001", end: "a0002", summary: "phase A summarized" });
  draft = addDraftRange(draft, atoms, { start: "a0004", end: "a0004", summary: "phase B summarized" });
  const state = {
    version: 1,
    createdAt: new Date().toISOString(),
    blocks: draft.ranges.map((range, i) => ({
      id: `c000${i + 1}`,
      summary: range.summary,
      entryIds: range.entryIds,
      messageKeys: range.messageKeys,
      createdAt: new Date().toISOString(),
      originalApproxTokens: range.originalApproxTokens,
      compressedApproxTokens: range.compressedApproxTokens,
    })),
  };
  const projected = projectMessages(messages, state);
  assert.equal(projected.length, 4);
  assert.equal(projected[0].customType, "midcompact-summary");
  assert.equal(projected[1].content, "critical constraint: keep API compatible");
  assert.equal(projected[2].customType, "midcompact-summary");
  assert.equal(projected[3].content, "current work");
});
