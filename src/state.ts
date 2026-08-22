// Persistence boundary. Owns restoration of CompressionState, TransactionState,
// and DraftPlan from the session branch. Provides backward-compatible defaults
// so old v1 state (without startMode) restores without migration. The runtime
// planning lock is not persisted here; it lives only in memory.

import type {
  CompressionState,
  DraftPlan,
  DraftRange,
  SessionEntryLike,
  StartMode,
  TransactionState,
} from "./types.js";

export const STATE_ENTRY = "midcompact-state";
export const TXN_ENTRY = "midcompact-transaction";
export const DRAFT_ENTRY = "midcompact-draft";

interface CustomEntryLike extends SessionEntryLike {
  data?: unknown;
}

export function emptyCompressionState(): CompressionState {
  return { version: 1, createdAt: new Date().toISOString(), blocks: [] };
}

/** Default routing for transactions persisted before startMode existed. */
export function defaultStartMode(mode: StartMode | undefined): StartMode {
  return mode ?? "agent";
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
} {
  let transaction: TransactionState | undefined;
  let draft: DraftPlan | undefined;
  for (const raw of entries) {
    const entry = raw as CustomEntryLike;
    if (entry.type !== "custom") continue;
    if (entry.customType === TXN_ENTRY && isTransaction(entry.data)) {
      transaction = entry.data;
      draft = undefined;
      continue;
    }
    if (entry.customType === DRAFT_ENTRY && transaction && isDraft(entry.data) && entry.data.transactionId === transaction.id) {
      draft = entry.data;
    }
  }
  return { transaction, draft };
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
