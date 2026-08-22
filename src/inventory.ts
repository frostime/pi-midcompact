// Read-only inspection over the frozen visible atom snapshot. Owns the
// user-led inventory and factual measurement of explicit candidate spans.
// Output is bounded and never returns full message or tool bodies.

import { isProtectedAtom } from "./atoms.js";
import { aggregateMetrics } from "./content-metrics.js";
import { toolCalls, truncateMiddle } from "./messages.js";
import type {
  Atom,
  InventoryGroup,
  InventoryPage,
  InventoryPiUsage,
  InventoryQuery,
  InventoryTotals,
  TransactionState,
} from "./types.js";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
export const SPAN_INSPECTION_OUTPUT_LIMIT = 12_000;

const USER_GROUP_LABEL_LIMIT = 80;
const SPAN_LANDMARK_LIMIT = 180;

export interface InspectSpan {
  start: string;
  end: string;
}

/** Opaque cursor encoding the next group index to start from. */
export function encodeCursor(nextGroupIndex: number): string {
  return btoa(JSON.stringify({ g: nextGroupIndex }));
}

export function decodeCursor(cursor: string): number | undefined {
  try {
    const decoded = JSON.parse(atob(cursor));
    if (decoded && typeof decoded.g === "number") return decoded.g;
    return undefined;
  } catch {
    return undefined;
  }
}

function piUsageFromAnchor(transaction: TransactionState): InventoryPiUsage {
  const usage = transaction.anchorUsage;
  if (!usage) {
    return { available: false, contextWindow: null, tokens: null, percent: null, provenance: "Pi reported at anchor start" };
  }
  return {
    available: true,
    contextWindow: usage.contextWindow,
    tokens: usage.tokens,
    percent: usage.percent,
    provenance: "Pi reported at anchor start",
  };
}

function buildGroups(atoms: readonly Atom[]): InventoryGroup[] {
  if (atoms.length === 0) return [];

  // Group boundaries: a new user-led group begins at each "user" atom. Atoms
  // before the first user atom form a single prefix group.
  const groups: InventoryGroup[] = [];
  let current: Atom[] | null = null;
  let groupIndex = 0;

  const flush = () => {
    if (!current) return;
    groups.push(buildGroup(groupIndex, current, /* isPrefix */ false));
    groupIndex += 1;
    current = null;
  };

  for (const atom of atoms) {
    if (atom.kind === "user") {
      flush();
      current = [atom];
    } else if (current) {
      current.push(atom);
    } else {
      // Before the first user message: seed a prefix group.
      current = [atom];
    }
  }
  flush();

  // Mark the prefix group: it is the first group whose first atom is not a user atom.
  if (groups.length > 0 && groups[0]!.startAtomRef === atoms[0]!.ref && atoms[0]!.kind !== "user") {
    groups[0] = { ...groups[0]!, isPrefix: true };
  }
  return groups;
}

function buildGroup(groupIndex: number, groupAtoms: readonly Atom[], isPrefix: boolean): InventoryGroup {
  const first = groupAtoms[0]!;
  const last = groupAtoms[groupAtoms.length - 1]!;
  const metrics = aggregateMetrics(groupAtoms.map((atom) => atom.metrics));
  let protectedCount = 0;
  let compressibleCount = 0;
  let messageCount = 0;
  for (const atom of groupAtoms) {
    if (isProtectedAtom(atom)) protectedCount += 1;
    else compressibleCount += 1;
    messageCount += atom.messages.length;
  }
  const mimeTypes = [...new Set(metrics.images.map((image) => image.mimeType))].sort();
  const label = groupLabel(first, isPrefix);
  return {
    ref: `g${String(groupIndex + 1).padStart(4, "0")}`,
    label,
    isPrefix,
    startAtomRef: first.ref,
    endAtomRef: last.ref,
    atomCount: groupAtoms.length,
    messageCount,
    contentChars: metrics.contentChars,
    imageCount: metrics.imageCount,
    imagePayloadBytes: metrics.images.reduce((sum, image) => sum + image.payloadBytes, 0),
    imageMimeTypes: mimeTypes,
    protectedAtomCount: protectedCount,
    compressibleAtomCount: compressibleCount,
  };
}

function groupLabel(firstAtom: Atom, isPrefix: boolean): string {
  if (isPrefix) return "context before first user message";
  const userMessage = firstAtom.messages.find((ref) => ref.message.role === "user");
  if (!userMessage) return firstAtom.ref;
  return truncateMiddle(renderUserLabel(userMessage.message), USER_GROUP_LABEL_LIMIT);
}

function renderUserLabel(message: import("./types.js").MessageLike): string {
  const text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? (message.content as Array<{ type?: string; text?: string }>).find((p) => p?.type === "text")?.text ?? ""
      : "";
  return text || `[${message.role}]`;
}

function buildTotals(atoms: readonly Atom[], groups: readonly InventoryGroup[]): InventoryTotals {
  const metrics = aggregateMetrics(atoms.map((atom) => atom.metrics));
  let protectedCount = 0;
  let compressibleCount = 0;
  for (const atom of atoms) {
    if (isProtectedAtom(atom)) protectedCount += 1;
    else compressibleCount += 1;
  }
  return {
    atomCount: atoms.length,
    messageCount: atoms.reduce((sum, atom) => sum + atom.messages.length, 0),
    contentChars: metrics.contentChars,
    imageCount: metrics.imageCount,
    imagePayloadBytes: metrics.images.reduce((sum, image) => sum + image.payloadBytes, 0),
    groupCount: groups.length,
    protectedAtomCount: protectedCount,
    compressibleAtomCount: compressibleCount,
  };
}

export interface InventoryContext {
  transaction: TransactionState;
}

export function buildInventory(atoms: readonly Atom[], query: InventoryQuery, context: InventoryContext): InventoryPage {
  const pageSize = clampPageSize(query.pageSize);
  const allGroups = buildGroups(atoms);
  const startGroup = query.cursor ? (decodeCursor(query.cursor) ?? 0) : 0;
  const safeStart = Math.max(0, Math.min(startGroup, allGroups.length));
  const slice = allGroups.slice(safeStart, safeStart + pageSize);
  const nextIndex = safeStart + slice.length;
  const nextCursor = nextIndex < allGroups.length ? encodeCursor(nextIndex) : null;

  return {
    anchor: { transactionId: context.transaction.id, anchorEntryId: context.transaction.anchorEntryId },
    piUsage: piUsageFromAnchor(context.transaction),
    totals: buildTotals(atoms, allGroups),
    groups: slice,
    nextCursor,
    pageSize,
  };
}

function clampPageSize(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return DEFAULT_PAGE_SIZE;
  const rounded = Math.round(requested);
  if (rounded < 1) return 1;
  return Math.min(rounded, MAX_PAGE_SIZE);
}

/** Format an inventory page with bounded user landmarks and no full bodies. */
export function formatInventory(page: InventoryPage): string {
  const lines: string[] = [];
  const usage = page.piUsage;
  if (usage.available) {
    const pct = usage.percent === null || !Number.isFinite(usage.percent) ? "unavailable" : `${round1(usage.percent)}%`;
    lines.push(`Anchor Pi usage (${usage.provenance}): ${usage.tokens === null ? "unavailable" : usage.tokens} / ${usage.contextWindow ?? "?"} tokens (${pct}).`);
  } else {
    lines.push(`Anchor Pi usage (${usage.provenance}): unavailable; not derived from local char counts.`);
  }
  lines.push(
    `Totals: ${page.totals.atomCount} atoms, ${page.totals.messageCount} messages, ${page.totals.contentChars} content chars, ${page.totals.imageCount} images (${page.totals.imagePayloadBytes} payload bytes), ${page.totals.groupCount} groups (${page.totals.protectedAtomCount} protected, ${page.totals.compressibleAtomCount} compressible).`,
  );
  lines.push(`Page ${page.groups.length === 0 ? "(empty)" : `${page.groups.length} group(s)`}:`);
  for (const group of page.groups) {
    const mimes = group.imageMimeTypes.length ? ` images: ${group.imageCount} (${group.imageMimeTypes.join("/")}, ${group.imagePayloadBytes} bytes)` : " images: 0";
    const prefix = group.isPrefix ? " [prefix]" : "";
    lines.push(
      `${group.ref}${prefix} ${group.startAtomRef}→${group.endAtomRef} | ${group.atomCount} atoms, ${group.messageCount} msgs, ${group.contentChars} chars,${mimes} | ${group.protectedAtomCount} protected / ${group.compressibleAtomCount} compressible | ${group.label}`,
    );
  }
  if (page.nextCursor) lines.push(`next cursor: ${page.nextCursor}`);
  lines.push("Note: inventory shows factual structure and bounded user landmarks only; no full message body, assistant/tool preview, summary, or image base64. Use locate for specific content.");
  return lines.join("\n");
}

/** Measure explicit, possibly overlapping candidate spans without mutating the DraftPlan. */
export function formatSpanInspection(atoms: readonly Atom[], spans: readonly InspectSpan[]): string {
  if (spans.length === 0) throw new Error("inspect spans requires at least one start/end span.");
  const byRef = new Map(atoms.map((atom) => [atom.ref, atom]));
  const anchorChars = aggregateMetrics(atoms.map((atom) => atom.metrics)).contentChars;
  const lines = [
    `Candidate span inspection: ${spans.length} requested · factual content measurements only; no per-span token estimate.`,
  ];
  let shown = 0;

  for (const span of spans) {
    const start = byRef.get(span.start);
    const end = byRef.get(span.end);
    if (!start || !end) throw new Error(`Unknown span ref ${!start ? span.start : span.end}; re-run inspect against the current snapshot.`);
    if (start.index > end.index) throw new Error(`Span ${span.start} → ${span.end} is reversed.`);

    const selected = atoms.slice(start.index, end.index + 1);
    const block = formatSpanBlock(selected, start, end, anchorChars);
    const currentLength = lines.join("\n\n").length;
    if (currentLength + 2 + block.length > SPAN_INSPECTION_OUTPUT_LIMIT) {
      const notice = `Output budget reached: showed ${shown} of ${spans.length} requested spans. Inspect the remainder in another call.`;
      if (currentLength + 2 + notice.length <= SPAN_INSPECTION_OUTPUT_LIMIT) lines.push(notice);
      break;
    }
    lines.push(block);
    shown += 1;
  }
  return lines.join("\n\n");
}

function formatSpanBlock(selected: readonly Atom[], start: Atom, end: Atom, anchorChars: number): string {
  const metrics = aggregateMetrics(selected.map((atom) => atom.metrics));
  const roleCounts = new Map<string, number>();
  const toolCounts = new Map<string, number>();
  let messageCount = 0;
  let toolCallCount = 0;
  let toolExchangeCount = 0;
  let protectedCount = 0;

  for (const atom of selected) {
    if (atom.kind === "tool_exchange") toolExchangeCount += 1;
    if (isProtectedAtom(atom)) protectedCount += 1;
    for (const ref of atom.messages) {
      messageCount += 1;
      roleCounts.set(ref.message.role, (roleCounts.get(ref.message.role) ?? 0) + 1);
      for (const call of toolCalls(ref.message)) {
        toolCallCount += 1;
        toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + 1);
      }
    }
  }

  const roleSummary = [...roleCounts.entries()].map(([role, count]) => `${role} ${count}`).join(" · ") || "none";
  const toolSummary = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ");
  const imageMimes = [...new Set(metrics.images.map((image) => image.mimeType))].sort();
  const imageBytes = metrics.images.reduce((sum, image) => sum + image.payloadBytes, 0);
  const charShare = anchorChars > 0 ? round1((metrics.contentChars / anchorChars) * 100) : "0";
  const protectedRefs = selected.filter(isProtectedAtom).map((atom) => atom.ref).join(", ");

  return [
    `${start.ref} → ${end.ref}`,
    `from: ${truncateMiddle(start.fullText, SPAN_LANDMARK_LIMIT)}`,
    `to: ${truncateMiddle(end.fullText, SPAN_LANDMARK_LIMIT)}`,
    `scope: ${selected.length} atoms · ${messageCount} messages (${roleSummary})`,
    `work: ${toolExchangeCount} tool exchanges · ${toolCallCount} tool calls${toolSummary ? ` (${truncateMiddle(toolSummary, SPAN_LANDMARK_LIMIT)})` : ""}`,
    `content: ${metrics.contentChars} chars · ${charShare}% of anchor factual content`,
    `images: ${metrics.imageCount}${imageMimes.length ? ` (${truncateMiddle(imageMimes.join("/"), SPAN_LANDMARK_LIMIT)}, ${imageBytes} payload bytes)` : ""}`,
    `selection: ${selected.length - protectedCount} compressible · ${protectedCount} protected${protectedRefs ? ` (${truncateMiddle(protectedRefs, SPAN_LANDMARK_LIMIT)})` : ""}`,
  ].join("\n");
}

function round1(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
