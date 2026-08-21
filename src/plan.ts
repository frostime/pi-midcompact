// Draft plan ownership. Owns pending-to-summarized draft transitions and the
// concise Agent-facing plan output. A DraftRange boundary can be fixed while
// its summary is still empty ("pending"); only ranges with non-empty summaries
// form a review draft and can commit. Plan output never echoes summary text or
// long previews.

import type { Atom, DraftPlan, DraftRange, DraftTelemetry } from "./types.js";
import { isProtectedAtom } from "./atoms.js";
import { estimateCompressedTokens, rangeMetricsForAtoms, replacementContentChars } from "./projection.js";
import { formatTelemetry } from "./telemetry.js";

export function emptyDraft(transactionId: string): DraftPlan {
  return { version: 1, transactionId, revision: 0, ranges: [] };
}

/** Add an ordinary draft range from start/end atom refs. Summary may be empty (pending). */
export function addDraftRange(
  draft: DraftPlan,
  atoms: Atom[],
  input: { start: string; end: string; summary?: string; topic?: string },
): DraftPlan {
  const start = atoms.find((atom) => atom.ref === input.start);
  const end = atoms.find((atom) => atom.ref === input.end);
  if (!start || !end) throw new Error("Unknown atom ref; run locate/inspect again against the current anchor snapshot.");
  if (start.index > end.index) throw new Error("start must not occur after end.");
  const selected = atoms.slice(start.index, end.index + 1);
  if (selected.length === 0) throw new Error("Empty range.");
  const unsafe = selected.find((atom) => isProtectedAtom(atom));
  if (unsafe) throw new Error(`Range crosses protected atom ${unsafe.ref} (${unsafe.kind}). Split the plan around it.`);
  const overlaps = draft.ranges.some((range) => !(end.index < range.startIndex || start.index > range.endIndex));
  if (overlaps) throw new Error("Range overlaps an existing draft range.");

  const metrics = rangeMetricsForAtoms(selected);
  const summary = input.summary ?? "";
  const replacement = replacementContentChars(summary, input.topic);
  const id = nextDraftId(draft);
  const range: DraftRange = {
    id,
    startRef: start.ref,
    endRef: end.ref,
    startIndex: start.index,
    endIndex: end.index,
    topic: input.topic,
    summary,
    entryIds: selected.flatMap((atom) => atom.entryIds),
    messageKeys: selected.flatMap((atom) => atom.messageKeys),
    originalContentChars: metrics.contentChars,
    originalImageCount: metrics.imageCount,
    originalImagePayloadBytes: metrics.images.reduce((sum, image) => sum + image.payloadBytes, 0),
    replacementContentChars: replacement,
    originalApproxTokens: selected.reduce((sum, atom) => sum + atom.approxTokens, 0),
    compressedApproxTokens: estimateCompressedTokens(summary, input.topic),
    startPreview: start.preview,
    endPreview: end.preview,
  };
  return { ...draft, revision: draft.revision + 1, ranges: [...draft.ranges, range].sort((a, b) => a.startIndex - b.startIndex) };
}

/** Create ranges from finalized ordinary spans (post selection subtraction). Summaries are pending (empty). */
export function addPendingRanges(
  draft: DraftPlan,
  atoms: Atom[],
  spans: readonly { startRef: string; endRef: string }[],
): DraftPlan {
  let next = draft;
  for (const span of spans) {
    next = addDraftRange(next, atoms, { start: span.startRef, end: span.endRef, summary: "" });
  }
  return next;
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
  const replacement = replacementContentChars(summary, topic);
  return {
    ...draft,
    revision: draft.revision + 1,
    ranges: draft.ranges.map((range) => range.id === draftId
      ? { ...range, summary, topic, replacementContentChars: replacement, compressedApproxTokens: estimateCompressedTokens(summary, topic) }
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

/** True when every range has a non-empty summary (i.e. the draft is review-ready). */
export function isReviewReady(draft: DraftPlan): boolean {
  return draft.ranges.length > 0 && draft.ranges.every((range) => range.summary.trim().length > 0);
}

/**
 * Concise Agent-facing plan output. Shows revision, range refs, factual
 * char/image stats, and pending state. Never echoes summary text or long
 * previews. Pi-reported awareness appears at the top as context only.
 */
export function formatDraft(draft: DraftPlan, telemetry?: DraftTelemetry): string {
  const lines: string[] = [];
  if (telemetry) lines.push(formatTelemetry(telemetry), "");
  if (draft.ranges.length === 0) {
    lines.push(`Draft v${draft.revision}: no compression ranges.`);
    return lines.join("\n");
  }
  const pendingCount = draft.ranges.filter((range) => range.summary.trim().length === 0).length;
  const reviewState = pendingCount === 0 ? "ready for review" : `${pendingCount} pending summary`;
  lines.push(`Draft v${draft.revision}: ${draft.ranges.length} range(s) (${reviewState}).`);
  for (const range of draft.ranges) {
    const status = range.summary.trim().length === 0 ? "pending summary" : "summarized";
    lines.push(`\n${range.id}: ${range.startRef} → ${range.endRef}${range.topic ? ` | ${range.topic}` : ""} [${status}]`);
    lines.push(`${range.originalContentChars} → ${range.replacementContentChars} content chars · ${range.originalImageCount} images (${range.originalImagePayloadBytes} payload bytes)`);
  }
  return lines.join("\n");
}
