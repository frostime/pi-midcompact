// Persistence boundary. Owns restoration of CompressionState, TransactionState,
// DraftPlan, and SelectionState from the session branch. Provides backward-
// compatible defaults so old v1 state (without mode/phase/Selection) restores
// and projects without migration.

import type {
  CompressionState,
  DraftPlan,
  DraftRange,
  SelectionState,
  SessionEntryLike,
  TransactionMode,
  TransactionPhase,
  TransactionState,
} from "./types.js";

export const STATE_ENTRY = "midcompact-state";
export const TXN_ENTRY = "midcompact-transaction";
export const DRAFT_ENTRY = "midcompact-draft";
export const SELECTION_ENTRY = "midcompact-selection";

interface CustomEntryLike extends SessionEntryLike {
  data?: unknown;
}

export function emptyCompressionState(): CompressionState {
  return { version: 1, createdAt: new Date().toISOString(), blocks: [] };
}

export function emptySelection(transactionId: string, mode: TransactionMode): SelectionState {
  return {
    version: 1,
    transactionId,
    mode,
    confirmed: false,
    spans: [],
    keepRefs: [],
    updatedAt: new Date().toISOString(),
  };
}

/** Default mode for transactions persisted before mode existed. */
export function defaultTransactionMode(mode: TransactionMode | undefined): TransactionMode {
  return mode ?? "agent";
}

/**
 * Default phase for transactions persisted before phase existed. Inferred from
 * the restored draft so an old Agent-first transaction resumes in a sensible
 * phase without losing its already-built ranges.
 */
export function defaultTransactionPhase(
  phase: TransactionPhase | undefined,
  draft?: DraftPlan,
): TransactionPhase {
  if (phase) return phase;
  const ranges = draft?.ranges ?? [];
  if (ranges.length === 0) return "selecting";
  // An old transaction with complete ranges was ready for review; an old
  // transaction with at least one pending summary was mid-summarizing.
  return ranges.every((range) => range.summary.trim().length > 0) ? "ready_for_review" : "summarizing";
}

export function restoreCompressionState(entries: readonly unknown[]): CompressionState | undefined {
  let latest: CompressionState | undefined;
  for (const raw of entries) {
    const entry = raw as CustomEntryLike;
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
    if (isCompressionState(entry.data)) latest = entry.data;
  }
  return latest;
}

export function restoreTransaction(entries: readonly unknown[]): {
  transaction?: TransactionState;
  draft?: DraftPlan;
  selection?: SelectionState;
} {
  let transaction: TransactionState | undefined;
  let draft: DraftPlan | undefined;
  let selection: SelectionState | undefined;
  for (const raw of entries) {
    const entry = raw as CustomEntryLike;
    if (entry.type !== "custom") continue;
    if (entry.customType === TXN_ENTRY && isTransaction(entry.data)) {
      transaction = entry.data;
      draft = undefined;
      selection = undefined;
      continue;
    }
    if (entry.customType === DRAFT_ENTRY && transaction && isDraft(entry.data) && entry.data.transactionId === transaction.id) {
      draft = entry.data;
      continue;
    }
    if (entry.customType === SELECTION_ENTRY && transaction && isSelection(entry.data) && entry.data.transactionId === transaction.id) {
      selection = entry.data;
    }
  }
  return { transaction, draft, selection };
}

export function isCompressionState(value: unknown): value is CompressionState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || typeof state.createdAt !== "string" || !Array.isArray(state.blocks)) return false;
  return state.blocks.every((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const block = raw as Record<string, unknown>;
    return typeof block.id === "string" && typeof block.summary === "string" && Array.isArray(block.entryIds) && Array.isArray(block.messageKeys);
  });
}

function isTransaction(value: unknown): value is TransactionState {
  if (!value || typeof value !== "object") return false;
  const tx = value as Record<string, unknown>;
  return tx.version === 1 && typeof tx.id === "string" && typeof tx.anchorEntryId === "string" && typeof tx.startedAt === "string";
}

function isDraft(value: unknown): value is DraftPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  return plan.version === 1 && typeof plan.transactionId === "string" && typeof plan.revision === "number" && Array.isArray(plan.ranges);
}

function isSelection(value: unknown): value is SelectionState {
  if (!value || typeof value !== "object") return false;
  const sel = value as Record<string, unknown>;
  return sel.version === 1 && typeof sel.transactionId === "string" && typeof sel.mode === "string" && typeof sel.confirmed === "boolean" && Array.isArray(sel.spans) && Array.isArray(sel.keepRefs);
}

/**
 * An old DraftRange may lack the factual char/image fields. Coerce to the
 * current shape so callers always see the new fields; missing values default to
 * 0 and are recomputed by the next mutation.
 */
export function coerceDraftRange(range: DraftRange): DraftRange {
  return {
    ...range,
    originalContentChars: typeof range.originalContentChars === "number" ? range.originalContentChars : 0,
    originalImageCount: typeof range.originalImageCount === "number" ? range.originalImageCount : 0,
    originalImagePayloadBytes: typeof range.originalImagePayloadBytes === "number" ? range.originalImagePayloadBytes : 0,
    replacementContentChars: typeof range.replacementContentChars === "number" ? range.replacementContentChars : 0,
    originalApproxTokens: typeof range.originalApproxTokens === "number" ? range.originalApproxTokens : 0,
    compressedApproxTokens: typeof range.compressedApproxTokens === "number" ? range.compressedApproxTokens : 0,
  };
}
