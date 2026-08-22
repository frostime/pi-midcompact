import test from "node:test";
import assert from "node:assert/strict";

const ROOT = new URL("../.test-dist/src/", import.meta.url);
const atomsMod = await import(new URL("atoms.js", ROOT));
const planMod = await import(new URL("plan.js", ROOT));
const projectionMod = await import(new URL("projection.js", ROOT));
const stateMod = await import(new URL("state.js", ROOT));
const telemetryMod = await import(new URL("telemetry.js", ROOT));
const contentMetricsMod = await import(new URL("content-metrics.js", ROOT));
const inventoryMod = await import(new URL("inventory.js", ROOT));
const selectionMod = await import(new URL("selection.js", ROOT));
const reviewMod = await import(new URL("review-ui.js", ROOT));
const reviewWebMod = await import(new URL("review-webui.js", ROOT));
const planningLockMod = await import(new URL("planning-lock.js", ROOT));

const { buildAtoms, locateAtoms, locateAtomMatches, formatLocatedAtom, MAX_LOCATE_MATCHES } = atomsMod;
const { addDraftRange, addPendingRanges, emptyDraft, formatDraft, isReviewReady, replaceDraftRanges } = planMod;
const { projectMessages } = projectionMod;
const { restoreCompressionState, STATE_ENTRY, coerceDraftRange, defaultStartMode } = stateMod;
const { draftTelemetry } = telemetryMod;
const { measureMessage, measureContentParts, codePointCount, readImageDimensions, aggregateMetrics } = contentMetricsMod;
const {
  buildInventory,
  formatInventory,
  formatSpanInspection,
  encodeCursor,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SPAN_INSPECTION_OUTPUT_LIMIT,
} = inventoryMod;
const { expandSelection, SelectionError } = selectionMod;
const { buildReviewText } = reviewMod;
const { serializeReviewState, showReviewWebUi } = reviewWebMod;
const { emptyPlanningLock, agentCanMutate, tryAcquireUi, acquireAgent, releaseAgent, releaseUi } = planningLockMod;

function entry(id, message, parentId = null) {
  return { type: "message", id, parentId, message };
}

const user = (text, timestamp) => ({ role: "user", content: text, timestamp });
const assistant = (content, timestamp) => ({ role: "assistant", content, timestamp });
const result = (id, toolName, text, timestamp) => ({ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], timestamp });

// Tiny 1x1 PNG (base64) for image fixtures: deterministic, decodes to 1x1 pixels.
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const GIF_1x1_BASE64 =
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

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
  const matches = locateAtoms(atoms, { pattern: "Redis", source: "assistant" });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].ref, "a0002");
});

test("locator bounds ambiguous searches and renders useful landmarks", () => {
  const messages = Array.from({ length: 5 }, (_, index) => assistant([
    { type: "text", text: `start ${index} ${"x".repeat(800)} distinctive needle ${"y".repeat(800)} end ${index}` },
  ], index + 1));
  const atoms = buildAtoms(messages, messages.map((message, index) => entry(`e${index + 1}`, message)));
  const located = locateAtomMatches(atoms, { pattern: "distinctive needle", limit: 20 });
  assert.equal(located.atoms.length, MAX_LOCATE_MATCHES);
  assert.equal(located.totalMatches, 5);

  const searchPreview = formatLocatedAtom(located.atoms[0], "brief", "distinctive needle");
  assert.match(searchPreview, /distinctive needle/);
  const directPreview = formatLocatedAtom(located.atoms[0], "brief");
  assert.match(directPreview, /start 0/);
  assert.match(directPreview, /end 0/);
  assert.match(directPreview, /chars omitted/);
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

test("plan show exposes bounded landmarks and stored summaries", () => {
  const messages = [user(`start ${"x".repeat(300)} user constraint`, 1), assistant([{ type: "text", text: `result ${"y".repeat(300)} final conclusion` }], 2)];
  const atoms = buildAtoms(messages, messages.map((message, index) => entry(`e${index + 1}`, message)));
  const longSummary = `summary start ${"z".repeat(50_000)} summary end`;
  const draft = addDraftRange(emptyDraft("tx"), atoms, { start: "a0001", end: "a0002", summary: longSummary, topic: "phase" });

  const brief = formatDraft(draft);
  assert.match(brief, /from: User: start/);
  assert.match(brief, /user constraint/);
  assert.match(brief, /to: Assistant: result/);
  assert.match(brief, /final conclusion/);
  assert.match(brief, /summary: summary start/);
  assert.match(brief, /summary end/);

  const full = formatDraft(draft, undefined, { detail: "full", draftId: "d1" });
  assert.ok(full.length <= 40_000);
  assert.match(full, /chars omitted/);
  assert.throws(() => formatDraft(draft, undefined, { detail: "full" }), /requires draft_id/);

  const legacy = {
    ...draft,
    ranges: draft.ranges.map(range => ({ ...range, startPreview: "legacy prefix only", endPreview: "legacy prefix only" })),
  };
  const refreshed = formatDraft(legacy, undefined, { atoms });
  assert.match(refreshed, /user constraint/);
  assert.match(refreshed, /final conclusion/);
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
      originalContentChars: range.originalContentChars,
      originalImageCount: range.originalImageCount,
      originalImagePayloadBytes: range.originalImagePayloadBytes,
      replacementContentChars: range.replacementContentChars,
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
      originalContentChars: range.originalContentChars,
      originalImageCount: range.originalImageCount,
      originalImagePayloadBytes: range.originalImagePayloadBytes,
      replacementContentChars: range.replacementContentChars,
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

test("draft telemetry reports factual chars/images and Pi usage, not local token authority", () => {
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
      originalContentChars: 88000, originalImageCount: 2, originalImagePayloadBytes: 512,
      replacementContentChars: 140, startPreview: "start", endPreview: "end",
      originalApproxTokens: 22000, compressedApproxTokens: 1000,
    }],
  };
  const telemetry = draftTelemetry(tx, draft);
  assert.equal(telemetry.anchorUsage.tokens, 70000);
  assert.equal(telemetry.selectedOriginalContentChars, 88000);
  assert.equal(telemetry.selectedReplacementContentChars, 140);
  assert.equal(telemetry.selectedImageCount, 2);
  assert.equal(telemetry.selectedImagePayloadBytes, 512);
  assert.equal(telemetry.rangeCount, 1);
  assert.equal(telemetry.pendingSummaryCount, 0);
  // Legacy fields retained for backward-compatible readers.
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

test("serializeReviewState exposes selection groups and factual atom metrics", () => {
  const messages = [user("phase one", 1), assistant([{ type: "text", text: "old exploration" }], 2)];
  const branch = messages.map((message, index) => entry(`e${index + 1}`, message));
  const atoms = buildAtoms(messages, branch);
  const draft = emptyDraft("tx-selection-web");
  const telemetry = draftTelemetry({ version: 1, id: "tx-selection-web", anchorEntryId: "e2", startedAt: "now" }, draft);

  const state = serializeReviewState(atoms, draft, telemetry, "selection");
  assert.equal(state.view, "selection");
  assert.equal(state.atoms[0].groupRef, "g0001");
  assert.match(state.atoms[0].groupLabel, /phase one/);
  assert.equal(state.atoms[0].contentChars, atoms[0].metrics.contentChars);
  assert.equal(state.atoms[0].imageCount, 0);
});

test("Web UI ends when its page liveness connection disappears", async () => {
  let ready;
  const readyUrl = new Promise((resolve) => { ready = resolve; });
  const ctx = {
    ui: {
      notify(text) {
        const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?view=review/);
        if (match) ready(match[0]);
      },
    },
  };
  const draft = emptyDraft("tx-web-liveness");
  const telemetry = draftTelemetry({ version: 1, id: "tx-web-liveness", anchorEntryId: "e1", startedAt: "now" }, draft);
  const workbench = showReviewWebUi(
    ctx,
    [],
    () => ({ draft, telemetry }),
    { editSummary() {}, editTopic() {}, remove() {} },
    "review",
    { openBrowser() {}, livenessConnectTimeoutMs: 2_000, livenessPingIntervalMs: 20 },
  );
  const url = await readyUrl;
  const response = await fetch(new URL("/api/liveness", url));
  await response.body.cancel();

  let completed = false;
  try {
    await Promise.race([
      workbench.then(() => { completed = true; }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Web UI did not close after liveness disconnect.")), 500)),
    ]);
    assert.equal(completed, true);
  } finally {
    if (!completed) await fetch(new URL("/api/close", url), { method: "POST" }).catch(() => {});
  }
});

// ---- Phase 2: factual content metrics ----

test("codePointCount counts Unicode code points, not UTF-16 units", () => {
  assert.equal(codePointCount("abc"), 3);
  assert.equal(codePointCount("中文"), 2);
  assert.equal(codePointCount("a😀b"), 3);
});

test("measureContentParts counts text/thinking/tool-call and never mixes image bytes into chars", () => {
  const expectedPngBytes = atob(PNG_1x1_BASE64).length;
  const metrics = measureContentParts([
    { type: "text", text: "hello" },
    { type: "thinking", thinking: "ponder" },
    { type: "toolCall", name: "read", arguments: { path: "a" } },
    { type: "image", mimeType: "image/png", data: PNG_1x1_BASE64 },
  ]);
  assert.equal(metrics.contentChars, 5 + 6 + 4 + codePointCount(JSON.stringify({ path: "a" })));
  assert.equal(metrics.imageCount, 1);
  assert.equal(metrics.images[0].mimeType, "image/png");
  assert.equal(metrics.images[0].payloadBytes, expectedPngBytes);
  assert.equal(metrics.images[0].width, 1);
  assert.equal(metrics.images[0].height, 1);
});

test("measureContentParts ignores unparseable image data but still records the image", () => {
  const metrics = measureContentParts([{ type: "image", mimeType: "image/png", data: "not-base64!!" }]);
  assert.equal(metrics.imageCount, 1);
  assert.equal(metrics.images[0].payloadBytes, 0);
});

test("readImageDimensions reads PNG and GIF headers", () => {
  function decode(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  assert.deepEqual(readImageDimensions(decode(PNG_1x1_BASE64)), { width: 1, height: 1 });
  assert.deepEqual(readImageDimensions(decode(GIF_1x1_BASE64)), { width: 1, height: 1 });
});

test("measureMessage counts bash command/output and custom summary fields", () => {
  const bash = measureMessage({ role: "bashExecution", command: "ls -la", output: "file1\nfile2" });
  assert.equal(bash.contentChars, codePointCount("ls -la") + codePointCount("file1\nfile2"));
  const custom = measureMessage({ role: "custom", customType: "note", content: "x", summary: "the summary" });
  assert.equal(custom.contentChars, codePointCount("x") + codePointCount("the summary"));
});

test("atom metrics aggregate message-level text and image facts across an exchange", () => {
  const messages = [
    assistant([
      { type: "text", text: "look" },
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
    ], 1),
    result("t1", "read", "ok", 2),
    assistant([{ type: "image", mimeType: "image/png", data: PNG_1x1_BASE64 }], 3),
  ];
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  // tool_exchange (a0001) + assistant image (a0002)
  assert.equal(atoms[0].metrics.contentChars > 0, true);
  assert.equal(atoms[1].metrics.imageCount, 1);
  assert.equal(atoms[1].metrics.images[0].payloadBytes, atob(PNG_1x1_BASE64).length);
});

test("aggregateMetrics re-indexes images sequentially", () => {
  const agg = aggregateMetrics([
    { contentChars: 5, imageCount: 1, images: [{ index: 0, mimeType: "image/png", payloadBytes: 10 }] },
    { contentChars: 3, imageCount: 1, images: [{ index: 0, mimeType: "image/gif", payloadBytes: 20 }] },
  ]);
  assert.equal(agg.contentChars, 8);
  assert.equal(agg.imageCount, 2);
  assert.deepEqual(agg.images.map(i => i.index), [0, 1]);
});

// ---- Phase 3: inventory ----

test("inventory groups by user message with a prefix group before the first user", () => {
  const messages = [
    assistant([{ type: "text", text: "system intro" }], 1), // before first user
    user("first task", 2),
    assistant([{ type: "text", text: "work" }], 3),
    user("second task", 4),
  ];
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  const page = buildInventory(atoms, {}, {
    transaction: { version: 1, id: "tx", anchorEntryId: "e4", startedAt: "now" },
  });
  assert.equal(page.groups.length, 3);
  assert.equal(page.groups[0].isPrefix, true);
  assert.equal(page.groups[0].startAtomRef, "a0001");
  assert.equal(page.groups[1].label, "first task");
  assert.equal(page.groups[2].label, "second task");
  assert.equal(page.totals.atomCount, 4);
  assert.equal(page.totals.groupCount, 3);
  // No assistant body, summary text, tool body, or image base64 in output.
  const text = formatInventory(page);
  assert.doesNotMatch(text, /system intro/);
  assert.doesNotMatch(text, /iVBOR/);
  assert.match(text, /content chars/);
  assert.match(text, /bounded user landmarks/);
  assert.doesNotMatch(text, /no preview/);
});

test("inventory pagination defaults to 20 and caps at 50, cursor continues without gaps", () => {
  const messages = [];
  for (let i = 0; i < 30; i++) messages.push(user(`task ${i}`, i + 1));
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  const ctx = { transaction: { version: 1, id: "tx", anchorEntryId: "e30", startedAt: "now" } };
  const first = buildInventory(atoms, {}, ctx);
  assert.equal(first.pageSize, DEFAULT_PAGE_SIZE);
  assert.equal(first.groups.length, 20);
  assert.ok(first.nextCursor);
  const second = buildInventory(atoms, { cursor: first.nextCursor }, ctx);
  assert.equal(second.groups.length, 10);
  assert.equal(second.nextCursor, null);
  // No group appears twice across pages.
  const allRefs = [...first.groups, ...second.groups].map(g => g.ref);
  assert.equal(new Set(allRefs).size, allRefs.length);
  // Cursor over max page size is capped.
  const big = buildInventory(atoms, { pageSize: 999 }, ctx);
  assert.equal(big.pageSize, MAX_PAGE_SIZE);
});

test("inspect spans compares overlapping candidates within one output budget", () => {
  const messages = [
    user("begin implementation", 1),
    assistant([
      { type: "text", text: "checking" },
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "t2", name: "bash", arguments: { command: "test" } },
    ], 2),
    result("t1", "read", "A", 3),
    result("t2", "bash", "ok", 4),
    assistant([{ type: "text", text: "implementation complete" }], 5),
  ];
  const atoms = buildAtoms(messages, messages.map((message, index) => entry(`e${index + 1}`, message)));
  const spans = Array.from({ length: 100 }, () => ({ start: "a0001", end: "a0003" }));
  const text = formatSpanInspection(atoms, spans);

  assert.match(text, /100 requested/);
  assert.match(text, /1 tool exchanges · 2 tool calls/);
  assert.match(text, /user 1/);
  assert.match(text, /% of anchor factual content/);
  assert.match(text, /no per-span token estimate/);
  assert.match(text, /Output budget reached/);
  assert.ok((text.match(/a0001 → a0003/g) ?? []).length > 3, "span inspection must be budget-bound, not capped at three");
  assert.ok(text.length <= SPAN_INSPECTION_OUTPUT_LIMIT);
});

test("inventory reports Pi usage provenance and unavailable when absent", () => {
  const atoms = buildAtoms([user("x", 1)], [entry("e1", user("x", 1))]);
  const withUsage = buildInventory(atoms, {}, {
    transaction: { version: 1, id: "tx", anchorEntryId: "e1", startedAt: "now", anchorUsage: { tokens: 5, contextWindow: 10, percent: 50, capturedAt: "now" } },
  });
  assert.equal(withUsage.piUsage.available, true);
  assert.match(formatInventory(withUsage), /Pi reported/);
  const noUsage = buildInventory(atoms, {}, {
    transaction: { version: 1, id: "tx", anchorEntryId: "e1", startedAt: "now" },
  });
  assert.equal(noUsage.piUsage.available, false);
  assert.match(formatInventory(noUsage), /unavailable; not derived from local char counts/);
});

test("inventory counts protected and compressible atoms", () => {
  const messages = [user("task", 1), result("orphan", "read", "x", 2), assistant([{ type: "text", text: "ok" }], 3)];
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  const page = buildInventory(atoms, {}, { transaction: { version: 1, id: "tx", anchorEntryId: "e3", startedAt: "now" } });
  // a0001 user, a0002 orphan_tool_result (protected), a0003 assistant -> all in one user-led group.
  const group = page.groups[0];
  assert.equal(group.protectedAtomCount, 1);
  assert.equal(group.compressibleAtomCount, 2);
});

// ---- Phase 5: selection core ----

test("expandSelection subtracts KEEP atoms and splits into ordinary spans", () => {
  const messages = [
    user("one", 1),
    assistant([{ type: "text", text: "two" }], 2),
    user("keep me", 3),
    assistant([{ type: "text", text: "four" }], 4),
  ];
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  const out = expandSelection(atoms, { spans: [{ startRef: "a0001", endRef: "a0004" }], keepRefs: ["a0003"] });
  assert.deepEqual(out.spans.map(s => [s.startRef, s.endRef]), [["a0001", "a0002"], ["a0004", "a0004"]]);
});

test("expandSelection subtracts protected atoms and rejects compressing only protected", () => {
  const messages = [user("one", 1), result("orphan", "read", "x", 2), assistant([{ type: "text", text: "three" }], 3)];
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  // Spanning across the protected orphan yields two ordinary spans around it.
  const out = expandSelection(atoms, { spans: [{ startRef: "a0001", endRef: "a0003" }], keepRefs: [] });
  assert.deepEqual(out.spans.map(s => [s.startRef, s.endRef]), [["a0001", "a0001"], ["a0003", "a0003"]]);
  // Selecting only the protected orphan is rejected.
  assert.throws(
    () => expandSelection(atoms, { spans: [{ startRef: "a0002", endRef: "a0002" }], keepRefs: [] }),
    /Cannot compress protected atom/,
  );
});

test("expandSelection merges adjacent fragments and drops empty ones", () => {
  const messages = [
    user("one", 1), assistant([{ type: "text", text: "two" }], 2),
    assistant([{ type: "text", text: "three" }], 3), assistant([{ type: "text", text: "four" }], 4),
  ];
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  // Two adjacent requested spans with no KEEP between merge into one run.
  const out = expandSelection(atoms, { spans: [{ startRef: "a0001", endRef: "a0002" }, { startRef: "a0003", endRef: "a0004" }], keepRefs: [] });
  assert.deepEqual(out.spans.map(s => [s.startRef, s.endRef]), [["a0001", "a0004"]]);
});

test("expandSelection rejects unknown refs and reversed spans", () => {
  const messages = [user("one", 1), assistant([{ type: "text", text: "two" }], 2)];
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  assert.throws(() => expandSelection(atoms, { spans: [{ startRef: "a0099", endRef: "a0001" }], keepRefs: [] }), /Unknown atom ref/);
  assert.throws(() => expandSelection(atoms, { spans: [{ startRef: "a0002", endRef: "a0001" }], keepRefs: [] }), /reversed/);
});

test("addPendingRanges creates ranges with empty (pending) summaries; isReviewReady only when filled", () => {
  const messages = [user("one", 1), assistant([{ type: "text", text: "two" }], 2), assistant([{ type: "text", text: "three" }], 3)];
  const branch = messages.map((m, i) => entry(`e${i + 1}`, m));
  const atoms = buildAtoms(messages, branch);
  const spans = [{ startRef: "a0001", endRef: "a0001" }, { startRef: "a0003", endRef: "a0003" }];
  let draft = addPendingRanges(emptyDraft("tx"), atoms, spans);
  assert.equal(draft.ranges.length, 2);
  assert.equal(draft.ranges.every(r => r.summary === ""), true);
  assert.equal(isReviewReady(draft), false);
  draft = { ...draft, ranges: draft.ranges.map((r, i) => ({ ...r, summary: `s${i}` })) };
  assert.equal(isReviewReady(draft), true);
});

// ---- Phase 6: state restore / compat ----

test("replaceDraftRanges preserves exact ranges and creates pending ranges for changed boundaries", () => {
  const messages = [
    user("phase one", 1),
    assistant([{ type: "text", text: "old exploration" }], 2),
    user("phase two", 3),
    assistant([{ type: "text", text: "more work" }], 4),
  ];
  const atoms = buildAtoms(messages, messages.map((message, index) => entry(`e${index + 1}`, message)));
  let draft = emptyDraft("tx-replace");
  draft = addDraftRange(draft, atoms, { start: "a0001", end: "a0002", summary: "keep this summary", topic: "phase one" });

  const replaced = replaceDraftRanges(draft, atoms, [
    { startRef: "a0001", endRef: "a0002" },
    { startRef: "a0003", endRef: "a0004" },
  ]);
  assert.equal(replaced.ranges.length, 2);
  assert.equal(replaced.ranges[0].summary, "keep this summary");
  assert.equal(replaced.ranges[0].topic, "phase one");
  assert.equal(replaced.ranges[1].summary, "");
  assert.equal(replaced.revision, draft.revision + 1);
});

test("defaultStartMode infers agent for old transactions", () => {
  assert.equal(defaultStartMode(undefined), "agent");
  assert.equal(defaultStartMode("user"), "user");
});

test("coerceDraftRange backfills factual fields for old DraftRange shapes", () => {
  const oldRange = { id: "d1", startRef: "a0001", endRef: "a0001", startIndex: 0, endIndex: 0, summary: "s", entryIds: [], messageKeys: [], originalApproxTokens: 10, compressedApproxTokens: 5, startPreview: "p", endPreview: "p" };
  const coerced = coerceDraftRange(oldRange);
  assert.equal(coerced.originalContentChars, 0);
  assert.equal(coerced.originalImageCount, 0);
  assert.equal(coerced.replacementContentChars, 0);
  assert.equal(coerced.originalApproxTokens, 10);
});

// ---- Planning lock (runtime mutex, not persisted) ----

test("planning lock: UI blocks Agent mutation and vice versa", () => {
  const lock = emptyPlanningLock();
  assert.equal(agentCanMutate(lock), true);
  assert.equal(tryAcquireUi(lock), true);
  assert.equal(lock.owner, "ui");
  // Agent cannot mutate while UI holds the lock.
  assert.equal(agentCanMutate(lock), false);
  // Re-acquiring UI is idempotent-ish: owner stays "ui".
  assert.equal(tryAcquireUi(lock), true);
});

test("planning lock: Agent blocks UI acquire", () => {
  const lock = emptyPlanningLock();
  acquireAgent(lock);
  assert.equal(lock.owner, "agent");
  assert.equal(tryAcquireUi(lock), false);
  assert.equal(lock.owner, "agent");
});

test("planning lock: releaseAgent on turn end frees the lock; releaseUi on disconnect frees it", () => {
  const agent = emptyPlanningLock();
  acquireAgent(agent);
  releaseAgent(agent);
  assert.equal(agent.owner, undefined);
  assert.equal(tryAcquireUi(agent), true);

  const ui = emptyPlanningLock();
  tryAcquireUi(ui);
  releaseUi(ui);
  assert.equal(ui.owner, undefined);
  assert.equal(agentCanMutate(ui), true);
});

test("planning lock: release is a no-op for the other owner", () => {
  const lock = emptyPlanningLock();
  acquireAgent(lock);
  releaseUi(lock); // UI release must not steal the Agent's lock
  assert.equal(lock.owner, "agent");
  // Agent release frees it; then UI can acquire and Agent release must not steal it.
  releaseAgent(lock);
  assert.equal(lock.owner, undefined);
  tryAcquireUi(lock);
  releaseAgent(lock); // Agent release must not steal the UI's lock
  assert.equal(lock.owner, "ui");
});
