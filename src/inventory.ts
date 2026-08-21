// Inventory aggregation over the frozen visible atom snapshot. Owns the
// first-user-message prefix group, user-message grouping, global totals, and
// bounded pagination with an opaque cursor. Inventory output is bounded and
// never returns atom preview, summary text, tool body, or image base64.

import { isProtectedAtom } from "./atoms.js";
import { aggregateMetrics } from "./content-metrics.js";
import { truncate } from "./messages.js";
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

const USER_GROUP_LABEL_LIMIT = 80;

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
  return truncate(renderUserLabel(userMessage.message), USER_GROUP_LABEL_LIMIT);
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

/** Format an inventory page into a bounded, preview-free tool result string. */
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
  lines.push("Note: inventory shows facts only; no preview, summary, tool body, or image base64. Use locate for specific content.");
  return lines.join("\n");
}

function round1(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
