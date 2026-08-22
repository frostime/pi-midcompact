// Draft plan ownership. Owns pending-to-summarized draft transitions and the
// bounded Agent-facing plan output. A DraftRange boundary can be fixed while
// its summary is still empty ("pending"); only ranges with non-empty summaries
// form a review draft and can commit. Show and mutation formatters expose
// bounded semantic landmarks without dumping the full shared plan repeatedly.

import type { Atom, DraftPlan, DraftRange, DraftTelemetry } from "./types.js";
import { isProtectedAtom } from "./atoms.js";
import { estimateCompressedTokens, rangeMetricsForAtoms, replacementContentChars } from "./projection.js";
import { formatTelemetry } from "./telemetry.js";
import { truncateMiddle } from "./messages.js";

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

/** Replace the current range set with normalized ordinary spans, preserving exact prior ranges. */
export function replaceDraftRanges(
  draft: DraftPlan,
  atoms: Atom[],
  spans: readonly { startRef: string; endRef: string }[],
): DraftPlan {
  const existing = new Map(draft.ranges.map((range) => [`${range.startRef}:${range.endRef}`, range]));
  let nextId = draft.ranges.reduce((max, range) => {
    const match = /^d(\d+)$/.exec(range.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const ranges: DraftRange[] = [];

  for (const span of spans) {
    const previous = existing.get(`${span.startRef}:${span.endRef}`);
    if (previous) {
      ranges.push(previous);
      continue;
    }
    const created = addDraftRange(emptyDraft(draft.transactionId), atoms, {
      start: span.startRef,
      end: span.endRef,
      summary: "",
    }).ranges[0]!;
    nextId += 1;
    ranges.push({ ...created, id: `d${nextId}` });
  }

  return { ...draft, revision: draft.revision + 1, ranges };
}

/** True when every range has a non-empty summary (i.e. the draft is review-ready). */
export function isReviewReady(draft: DraftPlan): boolean {
  return draft.ranges.length > 0 && draft.ranges.every((range) => range.summary.trim().length > 0);
}

const BRIEF_LANDMARK_LIMIT = 180;
const BRIEF_SUMMARY_LIMIT = 500;
const DRAFT_OUTPUT_LIMIT = 12_000;
const FULL_DRAFT_OUTPUT_LIMIT = 40_000;

export interface DraftFormatOptions {
  detail?: "brief" | "full";
  draftId?: string;
  atoms?: readonly Atom[];
}

/** Agent-facing plan output with bounded semantic landmarks and summaries. */
export function formatDraft(draft: DraftPlan, telemetry?: DraftTelemetry, options: DraftFormatOptions = {}): string {
  if (options.detail === "full" && !options.draftId) {
    throw new Error("plan show detail=full requires draft_id.");
  }
  const selected = options.draftId
    ? draft.ranges.filter((range) => range.id === options.draftId)
    : draft.ranges;
  const atomsByRef = options.atoms ? new Map(options.atoms.map((atom) => [atom.ref, atom])) : undefined;
  if (options.draftId && selected.length === 0) throw new Error(`Unknown draft range ${options.draftId}.`);

  const lines: string[] = [];
  if (telemetry) lines.push(formatTelemetry(telemetry));
  if (draft.ranges.length === 0) {
    lines.push(`Draft v${draft.revision}: no compression ranges.`);
    return lines.join("\n\n");
  }
  lines.push(draftHeader(draft));

  if (options.detail === "full") {
    const remainingBudget = Math.max(1, FULL_DRAFT_OUTPUT_LIMIT - lines.join("\n\n").length - 2);
    lines.push(formatRangeFull(selected[0]!, remainingBudget, atomsByRef));
    return lines.join("\n\n");
  }

  let shown = 0;
  for (const range of selected) {
    const block = formatRangeBrief(range, atomsByRef);
    const currentLength = lines.join("\n\n").length;
    if (currentLength + 2 + block.length > DRAFT_OUTPUT_LIMIT) {
      const notice = `Output budget reached: showed ${shown} of ${selected.length} range(s). Use draft_id to inspect one range.`;
      if (currentLength + 2 + notice.length <= DRAFT_OUTPUT_LIMIT) lines.push(notice);
      break;
    }
    lines.push(block);
    shown += 1;
  }
  return lines.join("\n\n");
}

/** Concise confirmation for one DraftPlan mutation; explicit show owns full awareness. */
export function formatPlanMutation(
  draft: DraftPlan,
  op: "add" | "update" | "remove",
  changedId: string,
  atoms?: readonly Atom[],
): string {
  const pendingCount = draft.ranges.filter((range) => range.summary.trim().length === 0).length;
  const verb = op === "add" ? "added" : op === "update" ? "updated" : "removed";
  const lines = [`Draft v${draft.revision}: ${verb} ${changedId} · ${draft.ranges.length} range(s) · ${pendingCount} pending summary.`];
  if (op !== "remove") {
    const changed = draft.ranges.find((range) => range.id === changedId);
    const atomsByRef = atoms ? new Map(atoms.map((atom) => [atom.ref, atom])) : undefined;
    if (changed) lines.push(formatRangeBrief(changed, atomsByRef));
  }
  return lines.join("\n\n");
}

function draftHeader(draft: DraftPlan): string {
  const pendingCount = draft.ranges.filter((range) => range.summary.trim().length === 0).length;
  const reviewState = pendingCount === 0 ? "ready for review" : `${pendingCount} pending summary`;
  return `Draft v${draft.revision}: ${draft.ranges.length} range(s) (${reviewState}).`;
}

function formatRangeBrief(range: DraftRange, atomsByRef?: ReadonlyMap<string, Atom>): string {
  const pending = range.summary.trim().length === 0;
  return [
    `${range.id}: ${range.startRef} → ${range.endRef}${range.topic ? ` | ${truncateMiddle(range.topic, BRIEF_LANDMARK_LIMIT)}` : ""} [${pending ? "pending summary" : "summarized"}]`,
    `from: ${truncateMiddle(rangeEndpoint(range, "start", atomsByRef), BRIEF_LANDMARK_LIMIT)}`,
    `to: ${truncateMiddle(rangeEndpoint(range, "end", atomsByRef), BRIEF_LANDMARK_LIMIT)}`,
    `summary: ${pending ? "<pending>" : truncateMiddle(range.summary, BRIEF_SUMMARY_LIMIT)}`,
    `metrics: ${range.originalContentChars} → ${range.replacementContentChars} content chars · ${range.originalImageCount} images (${range.originalImagePayloadBytes} payload bytes)`,
  ].join("\n");
}

function formatRangeFull(range: DraftRange, outputLimit: number, atomsByRef?: ReadonlyMap<string, Atom>): string {
  const prefix = [
    `${range.id}: ${range.startRef} → ${range.endRef}${range.topic ? ` | ${truncateMiddle(range.topic, BRIEF_LANDMARK_LIMIT)}` : ""} [${range.summary.trim() ? "summarized" : "pending summary"}]`,
    `from: ${truncateMiddle(rangeEndpoint(range, "start", atomsByRef), 700)}`,
    `to: ${truncateMiddle(rangeEndpoint(range, "end", atomsByRef), 700)}`,
    "summary: ",
    `metrics: ${range.originalContentChars} → ${range.replacementContentChars} content chars · ${range.originalImageCount} images (${range.originalImagePayloadBytes} payload bytes)`,
  ];
  const fixedLength = prefix.join("\n").length;
  const summaryBudget = Math.max(1, outputLimit - fixedLength);
  const summary = range.summary.trim()
    ? range.summary.length <= summaryBudget ? range.summary : truncateMiddle(range.summary, summaryBudget)
    : "<pending>";
  prefix[3] = `summary: ${summary}`;
  return prefix.join("\n");
}

function rangeEndpoint(range: DraftRange, side: "start" | "end", atomsByRef?: ReadonlyMap<string, Atom>): string {
  const ref = side === "start" ? range.startRef : range.endRef;
  const stored = side === "start" ? range.startPreview : range.endPreview;
  return atomsByRef?.get(ref)?.fullText || stored || ref;
}
