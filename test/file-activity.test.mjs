import test from "node:test";
import assert from "node:assert/strict";
import { buildAtoms } from "../.test-dist/src/atoms.js";
import { addDraftRange, emptyDraft, formatDraft, isReviewReady, replaceDraftRanges, updateDraftRange } from "../.test-dist/src/plan.js";
import { projectMessages, replacementContentChars, replacementSummary, summaryMessage } from "../.test-dist/src/projection.js";
import { codePointCount } from "../.test-dist/src/content-metrics.js";
import { draftTelemetry } from "../.test-dist/src/telemetry.js";
import { buildReviewText } from "../.test-dist/src/review-ui.js";
import { serializeReviewState } from "../.test-dist/src/review-webui.js";
import { coerceDraftRange, isCompressionState, restoreTransaction } from "../.test-dist/src/state.js";
import { setupRuntime, user } from "./runtime-helpers.mjs";

const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, toolName, extra = {}) => ({ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text: "tool-output-not-an-appendix" }], ...extra });
const unusualPath = 'docs/quoted"\n名称.md';
const expectedActivity = {
  readPaths: [unusualPath, "src/a.ts"],
  writePaths: ["artifact.json", "src/failure.ts"],
};

function history() {
  const messages = [
    user("Retain this instruction.", 1),
    { role: "assistant", content: [call("kept", "read", { path: "kept-only.md" })] },
    result("kept", "read"),
    { role: "assistant", content: [
      call("read1", "read", { path: "src/a.ts" }),
      call("read2", "read", { path: "src/a.ts" }),
      call("failed", "edit", { path: "src/failure.ts" }),
      call("shell", "bash", { command: "cat shell-only.md > shell-output.md", path: "not-a-read.md" }),
    ] },
    result("read1", "read"), result("read2", "read"), result("failed", "edit", { isError: true }), result("shell", "bash"),
    { role: "assistant", content: [call("nested", "codemode", { code: "opaque" })] },
    result("nested", "codemode", { nestedCalls: { calls: [
      { name: "read", arguments: { path: "src/a.ts" } },
      { name: "read", arguments: { path: unusualPath } },
      { name: "write", arguments: { path: "artifact.json", content: "not-an-appendix" } },
      { name: "custom", arguments: { path: "unsupported.md" } },
      { name: "read", arguments: { path: 42 } },
      { name: "write" }, // Hosts can omit oversized nested-call arguments.
    ] } }),
    user("Current work.", 10),
  ];
  const entries = messages.map((message, i) => ({ type: "message", id: `e${i + 1}`, parentId: i ? `e${i}` : null, message }));
  return { messages, entries, atoms: buildAtoms(messages, entries) };
}

const tx = { version: 1, id: "tx-files", anchorEntryId: "e10", startedAt: "now" };

test("range file activity indexes only selected structured calls, including errors and nested calls", () => {
  const { atoms } = history();
  const draft = addDraftRange(emptyDraft(tx.id), atoms, { start: "a0003", end: "a0004", summary: "Historical investigation." });
  const range = draft.ranges[0];
  assert.deepEqual(range.fileActivity, expectedActivity);
  const shown = formatDraft(draft, undefined, { detail: "full", draftId: range.id });
  assert.ok(shown.includes(JSON.stringify(unusualPath)), "paths retain quotes, newlines and Unicode without becoming extra lines");
  assert.match(shown, /recorded calls, not verified outcomes/);
  assert.doesNotMatch(replacementSummary(range.summary, range.fileActivity), /kept-only|shell-only|shell-output|unsupported|not-a-read|tool-output-not-an-appendix/);

  const abandoned = { role: "assistant", content: [call("lost", "write", { path: "attempt-only.ts" })] };
  const abandonedAtoms = buildAtoms([abandoned], [{ type: "message", id: "lost-entry", message: abandoned }]);
  const pending = addDraftRange(emptyDraft("pending"), abandonedAtoms, { start: "a0001", end: "a0001" });
  assert.deepEqual(pending.ranges[0].fileActivity.writePaths, ["attempt-only.ts"]);
  assert.equal(isReviewReady(pending), false, "automatic facts do not fill a missing authored summary");
  assert.match(formatDraft(pending), /pending/);
});

test("review, editing, boundary replacement and projection share the measured appendix", () => {
  const { atoms, messages } = history();
  let draft = addDraftRange(emptyDraft(tx.id), atoms, { start: "a0003", end: "a0004", summary: "First summary." });
  draft = updateDraftRange(draft, "d1", { summary: "Updated factual summary.", topic: "Investigation" });
  const range = draft.ranges[0];
  assert.deepEqual(range.fileActivity, expectedActivity);
  const body = replacementSummary(range.summary, range.fileActivity);
  assert.equal(body.split("### File activity").length - 1, 1);
  const telemetry = draftTelemetry(tx, draft);
  const web = serializeReviewState(atoms, draft, telemetry).draft.ranges[0];
  assert.equal(web.summary, "Updated factual summary.", "the editor does not receive the appendix as editable summary");
  assert.match(web.fileActivityText, /src\/failure.ts/);
  assert.equal(web.replacementNarrowChars + web.replacementWideChars, range.replacementContentChars);
  assert.equal(range.replacementContentChars, replacementContentChars(range.summary, range.topic, expectedActivity));
  assert.ok(range.replacementContentChars > replacementContentChars(range.summary, range.topic));
  assert.ok(buildReviewText(atoms, draft, telemetry).includes(body));
  assert.ok(formatDraft(draft, telemetry, { detail: "full", draftId: "d1" }).includes(body));

  const block = { ...range, id: "c0001", createdAt: "now" };
  const projected = projectMessages(messages, { version: 1, blocks: [block] });
  const replacement = projected.find((message) => message.customType === "midcompact-summary");
  assert.ok(replacement.content.includes(body));
  assert.equal(codePointCount(replacement.content), range.replacementContentChars);

  const resized = replaceDraftRanges(draft, atoms, [{ startRef: "a0004", endRef: "a0004" }]);
  assert.equal(resized.ranges[0].summary, "");
  assert.deepEqual(resized.ranges[0].fileActivity.writePaths, ["artifact.json"], "new boundaries re-extract rather than carry facts from removed atoms");
});

test("old v1 ranges and blocks get no unseen appendix; malformed new persisted metadata is rejected", () => {
  const { atoms } = history();
  const range = addDraftRange(emptyDraft(tx.id), atoms, { start: "a0003", end: "a0004", summary: "Legacy summary." }).ranges[0];
  delete range.fileActivity;
  assert.equal(coerceDraftRange(range).fileActivity, undefined);
  const state = { version: 1, createdAt: "now", blocks: [{ ...range, id: "c0001" }] };
  assert.equal(isCompressionState(state), true);
  assert.doesNotMatch(summaryMessage(state.blocks[0]).content, /File activity/);
  const entries = [
    { type: "custom", customType: "midcompact-transaction", data: tx },
    { type: "custom", customType: "midcompact-draft", data: { ...emptyDraft(tx.id), ranges: [range] } },
  ];
  assert.equal(restoreTransaction(entries).draft.ranges[0].fileActivity, undefined);
  state.blocks[0].fileActivity = { readPaths: "not-an-array", writePaths: [] };
  assert.equal(isCompressionState(state), false);
  entries[1].data.ranges[0].fileActivity = { readPaths: [], writePaths: [42] };
  assert.equal(restoreTransaction(entries).draft, undefined);
});

test("runtime keeps reviewed file activity across reload and commit without adding planning-branch calls", async () => {
  const { messages, entries } = history();
  const { sm, pi, toolCtx, commandCtx } = setupRuntime(entries);
  await pi.emit("session_start", { reason: "startup" }, toolCtx);
  toolCtx.ui.selectResults = [0];
  await pi.commands.get("midcompact:start").handler("", commandCtx);
  const tool = pi.tools.get("midcompact");
  const execute = (request) => tool.execute("file-test", { request }, null, null, toolCtx);
  const planningId = `x${++pi.counter}`;
  entries.push({ type: "message", id: planningId, parentId: sm.leafId, message: { role: "assistant", content: [call("planning", "write", { path: "planning-only.md" })] } });
  sm.leafId = planningId;
  await execute({ action: "plan_add", start: "a0003", end: "a0004", summary: "Recorded investigation; one edit failed." });
  const beforeReload = await execute({ action: "plan_read", range_id: "d1" });
  await pi.emit("session_start", { reason: "reload" }, toolCtx);
  const afterReload = await execute({ action: "plan_read", range_id: "d1" });
  assert.equal(afterReload.content[0].text, beforeReload.content[0].text);
  assert.doesNotMatch(afterReload.content[0].text, /planning-only|kept-only/);
  await pi.emit("agent_settled", { type: "agent_settled" }, toolCtx);
  await pi.commands.get("midcompact:commit").handler("", commandCtx);
  const committed = sm.getBranch().find((entry) => entry.customType === "midcompact-state").data;
  assert.deepEqual(committed.blocks[0].fileActivity, expectedActivity);
  assert.equal(committed.blocks[0].summary, "Recorded investigation; one edit failed.");
  await pi.emit("session_start", { reason: "reload" }, toolCtx);
  const projected = await pi.emit("context", { messages: structuredClone(messages) }, toolCtx);
  const replacement = projected.messages.find((message) => message.customType === "midcompact-summary");
  assert.match(replacement.content, /src\/failure.ts/);
  assert.doesNotMatch(replacement.content, /planning-only|kept-only/);
  assert.equal(codePointCount(replacement.content), committed.lastCommit.selectedReplacementContentChars);
  const found = await execute({ action: "recall_list", pattern: "artifact.json" });
  assert.match(found.content[0].text, /c0001/);
});
