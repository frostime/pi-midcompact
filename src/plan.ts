import type { Atom, DraftPlan, DraftRange, DraftTelemetry } from "./types.js";
import { estimateCompressedTokens } from "./projection.js";
import { formatTelemetry } from "./telemetry.js";

export function emptyDraft(transactionId: string): DraftPlan {
  return { version: 1, transactionId, revision: 0, ranges: [] };
}

export function addDraftRange(
  draft: DraftPlan,
  atoms: Atom[],
  input: { start: string; end: string; summary: string; topic?: string },
): DraftPlan {
  const start = atoms.find((atom) => atom.ref === input.start);
  const end = atoms.find((atom) => atom.ref === input.end);
  if (!start || !end) throw new Error("Unknown atom ref; run locate again against the current anchor snapshot.");
  if (start.index > end.index) throw new Error("start must not occur after end.");
  const selected = atoms.slice(start.index, end.index + 1);
  if (selected.length === 0) throw new Error("Empty range.");
  const unsafe = selected.find((atom) => !atom.compressible || !atom.protocolClosed || atom.kind === "compressed");
  if (unsafe) throw new Error(`Range crosses protected atom ${unsafe.ref} (${unsafe.kind}). Split the plan around it.`);
  const overlaps = draft.ranges.some((range) => !(end.index < range.startIndex || start.index > range.endIndex));
  if (overlaps) throw new Error("Range overlaps an existing draft range.");
  const id = nextDraftId(draft);
  const range: DraftRange = {
    id,
    startRef: start.ref,
    endRef: end.ref,
    startIndex: start.index,
    endIndex: end.index,
    topic: input.topic,
    summary: input.summary,
    entryIds: selected.flatMap((atom) => atom.entryIds),
    messageKeys: selected.flatMap((atom) => atom.messageKeys),
    originalApproxTokens: selected.reduce((sum, atom) => sum + atom.approxTokens, 0),
    compressedApproxTokens: estimateCompressedTokens(input.summary, input.topic),
    startPreview: start.preview,
    endPreview: end.preview,
  };
  return { ...draft, revision: draft.revision + 1, ranges: [...draft.ranges, range].sort((a, b) => a.startIndex - b.startIndex) };
}

export function updateDraftRange(
  draft: DraftPlan,
  draftId: string,
  patch: { summary?: string; topic?: string },
): DraftPlan {
  const target = draft.ranges.find((range) => range.id === draftId);
  if (!target) throw new Error(`Unknown draft range ${draftId}.`);
  const summary = patch.summary ?? target.summary;
  const topic = patch.topic ?? target.topic;
  return {
    ...draft,
    revision: draft.revision + 1,
    ranges: draft.ranges.map((range) => range.id === draftId
      ? { ...range, summary, topic, compressedApproxTokens: estimateCompressedTokens(summary, topic) }
      : range),
  };
}

export function removeDraftRange(draft: DraftPlan, draftId: string): DraftPlan {
  if (!draft.ranges.some((range) => range.id === draftId)) throw new Error(`Unknown draft range ${draftId}.`);
  return { ...draft, revision: draft.revision + 1, ranges: draft.ranges.filter((range) => range.id !== draftId) };
}

function nextDraftId(draft: DraftPlan): string {
  let max = 0;
  for (const range of draft.ranges) {
    const match = /^d(\d+)$/.exec(range.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `d${max + 1}`;
}

export function formatDraft(draft: DraftPlan, telemetry?: DraftTelemetry): string {
  const lines: string[] = [];
  if (telemetry) lines.push(formatTelemetry(telemetry), "");
  if (draft.ranges.length === 0) {
    lines.push(`Draft v${draft.revision}: no compression ranges.`);
    return lines.join("\n");
  }
  const before = draft.ranges.reduce((sum, range) => sum + range.originalApproxTokens, 0);
  const after = draft.ranges.reduce((sum, range) => sum + range.compressedApproxTokens, 0);
  lines.push(`Draft v${draft.revision}: ${draft.ranges.length} range(s), ~${before} → ~${after} tokens`);
  for (const range of draft.ranges) {
    lines.push(`\n${range.id}: ${range.startRef} → ${range.endRef}${range.topic ? ` | ${range.topic}` : ""}`);
    lines.push(`~${range.originalApproxTokens} → ~${range.compressedApproxTokens} tokens`);
    lines.push(`start: ${range.startPreview}`);
    if (range.endRef !== range.startRef) lines.push(`end: ${range.endPreview}`);
  }
  return lines.join("\n");
}
