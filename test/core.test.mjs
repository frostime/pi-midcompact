import test from "node:test";
import assert from "node:assert/strict";

const ROOT = new URL("../.test-dist/src/", import.meta.url);
const atomsMod = await import(new URL("atoms.js", ROOT));
const planMod = await import(new URL("plan.js", ROOT));
const projectionMod = await import(new URL("projection.js", ROOT));
const stateMod = await import(new URL("state.js", ROOT));
const telemetryMod = await import(new URL("telemetry.js", ROOT));
const reviewMod = await import(new URL("review-ui.js", ROOT));
const reviewWebMod = await import(new URL("review-webui.js", ROOT));

const { buildAtoms, locateAtoms } = atomsMod;
const { addDraftRange, emptyDraft } = planMod;
const { projectMessages } = projectionMod;
const { restoreCompressionState, STATE_ENTRY } = stateMod;
const { draftTelemetry } = telemetryMod;
const { buildReviewText } = reviewMod;
const { serializeReviewState } = reviewWebMod;

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


test("draft telemetry gives context awareness without defining a target", () => {
  const tx = {
    version: 1,
    id: "tx-awareness",
    anchorEntryId: "e3",
    startedAt: "now",
    anchorUsage: { tokens: 70000, contextWindow: 100000, percent: 70, capturedAt: "now" },
  };
  const draft = {
    version: 1,
    transactionId: tx.id,
    revision: 1,
    ranges: [{
      id: "d1", startRef: "a0001", endRef: "a0002", startIndex: 0, endIndex: 1,
      summary: "short summary", entryIds: ["e1", "e2"], messageKeys: ["k1", "k2"],
      originalApproxTokens: 22000, compressedApproxTokens: 1000, startPreview: "start", endPreview: "end",
    }],
  };
  const telemetry = draftTelemetry(tx, draft);
  assert.equal(telemetry.anchorTokens, 70000);
  assert.equal(telemetry.estimatedSavedTokens, 21000);
  assert.equal(telemetry.projectedTokens, 49000);
  assert.equal(telemetry.projectedPercent, 49);
  assert.equal("target" in telemetry, false);
});

test("review text maps the linear atom stream to draft ranges and visible KEEP holes", () => {
  const messages = [
    user("phase one", 1),
    assistant([{ type: "text", text: "old exploration" }], 2),
    user("critical keep", 3),
    assistant([{ type: "text", text: "more old work" }], 4),
  ];
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  let draft = emptyDraft("tx-review");
  draft = addDraftRange(draft, atoms, { start: "a0001", end: "a0002", summary: "phase one summarized" });
  draft = addDraftRange(draft, atoms, { start: "a0004", end: "a0004", summary: "more old work summarized" });
  const telemetry = draftTelemetry({
    version: 1, id: "tx-review", anchorEntryId: "e4", startedAt: "now",
    anchorUsage: { tokens: 40000, contextWindow: 100000, percent: 40, capturedAt: "now" },
  }, draft);
  const text = buildReviewText(atoms, draft, telemetry);
  assert.match(text, /d1 a0001/);
  assert.match(text, /KEEP a0003 \[user\].*critical keep/);
  assert.match(text, /d2 a0004/);
  assert.match(text, /awareness, not a target/i);
  assert.match(text, /Projected/);
});

test("serializeReviewState maps atoms to ranges and tags range boundaries", () => {
  const messages = [
    user("phase one", 1),
    assistant([{ type: "text", text: "old exploration" }], 2),
    user("critical keep", 3),
    assistant([{ type: "text", text: "more old work" }], 4),
  ];
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  let draft = emptyDraft("tx-web");
  draft = addDraftRange(draft, atoms, { start: "a0001", end: "a0002", summary: "phase one summarized", topic: "intro" });
  const telemetry = draftTelemetry({ version: 1, id: "tx-web", anchorEntryId: "e4", startedAt: "now" }, draft);
  const state = serializeReviewState(atoms, draft, telemetry);
  assert.equal(state.draft.revision, 1);
  assert.equal(state.draft.ranges.length, 1);
  const r = state.draft.ranges[0];
  assert.equal(r.id, "d1");
  assert.equal(r.topic, "intro");
  assert.equal(r.atomCount, 2);
  const inRange = state.atoms.filter(a => a.owningRangeId === "d1");
  assert.equal(inRange.length, 2);
  assert.equal(inRange[0].isRangeStart, true);
  assert.equal(inRange[0].isRangeEnd, false);
  assert.equal(inRange[1].isRangeStart, false);
  assert.equal(inRange[1].isRangeEnd, true);
  const keep = state.atoms.find(a => a.ref === "a0003");
  assert.equal(keep.owningRangeId, undefined);
});
