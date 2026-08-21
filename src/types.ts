// Shared data contracts. This module defines structures only; it owns no
// metric, grouping, selection, or persistence rules.

export interface MessageLike {
  role: string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  customType?: string;
  details?: unknown;
  command?: string;
  output?: string;
  summary?: string;
  display?: boolean;
}

export interface SessionEntryLike {
  id: string;
  parentId?: string | null;
  type: string;
  customType?: string;
  data?: unknown;
  message?: MessageLike;
}

export interface MessageRef {
  message: MessageLike;
  key: string;
  entryId?: string;
}

export type AtomKind =
  | "user"
  | "assistant"
  | "tool_exchange"
  | "bash"
  | "compressed"
  | "custom"
  | "orphan_tool_result"
  | "other";

/** Factual measurement of a single image content part. */
export interface ImageFact {
  /** Sequence within the owning message. */
  index: number;
  mimeType: string;
  /** Decoded base64 payload length in bytes. */
  payloadBytes: number;
  /** Pixel dimensions when reliably readable; absent otherwise. */
  width?: number;
  height?: number;
}

/** Factual content statistics for a message, atom, group, or range. */
export interface ContentMetrics {
  /** Unicode code point count of visible content text fields. */
  contentChars: number;
  imageCount: number;
  images: ImageFact[];
}

export interface Atom {
  ref: string;
  index: number;
  kind: AtomKind;
  messages: MessageRef[];
  entryIds: string[];
  messageKeys: string[];
  preview: string;
  fullText: string;
  /** Factual content metrics aggregated across this atom's messages. */
  metrics: ContentMetrics;
  /** @deprecated legacy approximate token estimate; kept for old readers, not authoritative. */
  approxTokens: number;
  compressible: boolean;
  protocolClosed: boolean;
  toolNames: string[];
  roles: string[];
  compressedBlockId?: string;
}

export interface ContextUsageSnapshot {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  capturedAt: string;
}

export interface CompressionBlock {
  id: string;
  topic?: string;
  summary: string;
  entryIds: string[];
  messageKeys: string[];
  createdAt: string;
  /** Factual original content chars replaced by this block. */
  originalContentChars: number;
  /** Factual image count in the original range. */
  originalImageCount: number;
  /** Factual decoded image payload bytes in the original range. */
  originalImagePayloadBytes: number;
  /** Factual replacement message content chars (midcompact wrapper + summary). */
  replacementContentChars: number;
  /** @deprecated legacy approximate token estimate; kept for old readers, not authoritative. */
  originalApproxTokens: number;
  /** @deprecated legacy approximate token estimate; kept for old readers, not authoritative. */
  compressedApproxTokens: number;
}

export interface CommitStats {
  transactionId: string;
  committedAt: string;
  addedBlockIds: string[];
  addedRangeCount: number;
  /** Factual totals for the committed ranges. */
  selectedOriginalContentChars: number;
  selectedReplacementContentChars: number;
  selectedImageCount: number;
  selectedImagePayloadBytes: number;
  anchorUsage?: ContextUsageSnapshot;
  /** @deprecated legacy approximate token fields; kept for old readers, not authoritative. */
  selectedOriginalApproxTokens: number;
  selectedCompressedApproxTokens: number;
  estimatedSavedTokens: number;
  projectedTokens: number | null;
  projectedPercent: number | null;
}

export interface CompressionState {
  /** State format stays v1 for backward compatibility with v0.1.x sessions. */
  version: 1;
  createdAt: string;
  blocks: CompressionBlock[];
  lastCommit?: CommitStats;
}

export interface DraftRange {
  id: string;
  startRef: string;
  endRef: string;
  startIndex: number;
  endIndex: number;
  topic?: string;
  /** Empty until a summary is written; a range with empty summary is "pending". */
  summary: string;
  entryIds: string[];
  messageKeys: string[];
  /** Factual original content chars in this range. */
  originalContentChars: number;
  originalImageCount: number;
  originalImagePayloadBytes: number;
  /** Factual replacement message content chars (wrapper + summary). */
  replacementContentChars: number;
  /** @deprecated legacy approximate token estimate; kept for old readers, not authoritative. */
  originalApproxTokens: number;
  /** @deprecated legacy approximate token estimate; kept for old readers, not authoritative. */
  compressedApproxTokens: number;
  startPreview: string;
  endPreview: string;
}

export interface DraftPlan {
  version: 1;
  transactionId: string;
  revision: number;
  ranges: DraftRange[];
}

/** How a transaction's initial DraftPlan editing is routed. Informational only; */
/** both routes operate on the same DraftPlan and do not freeze boundaries. */
export type StartMode = "agent" | "user";

export interface TransactionState {
  version: 1;
  id: string;
  anchorEntryId: string;
  startedAt: string;
  /** Initial routing chosen at start: Agent-first prompt or User-first UI. */
  startMode?: StartMode;
  /** Frozen awareness captured when /midcompact starts; informational, never a target. */
  anchorUsage?: ContextUsageSnapshot;
}

/** Who currently holds the runtime mutex over DraftPlan edits. Not persisted. */
export type PlanningLockOwner = "agent" | "ui";

/** A requested atom span that may cross KEEP/protected atoms; fed into selection normalization. */
export interface SelectionSpan {
  startRef: string;
  endRef: string;
}

/** A finalized ordinary span after KEEP/protected subtraction. */
export interface OrdinarySpan {
  startRef: string;
  endRef: string;
  startIndex: number;
  endIndex: number;
}

export interface DraftTelemetry {
  /** Pi-reported usage at the frozen anchor; informational. */
  anchorUsage?: ContextUsageSnapshot;
  /** @deprecated Pi-reported anchor context window; use anchorUsage. Kept for UI readers. */
  contextWindow: number | null;
  /** @deprecated Pi-reported anchor tokens; use anchorUsage. Kept for UI readers. */
  anchorTokens: number | null;
  /** @deprecated Pi-reported anchor percent; use anchorUsage. Kept for UI readers. */
  anchorPercent: number | null;
  /** Factual selected metrics. */
  selectedOriginalContentChars: number;
  selectedReplacementContentChars: number;
  selectedImageCount: number;
  selectedImagePayloadBytes: number;
  rangeCount: number;
  /** Ranges still awaiting a non-empty summary. */
  pendingSummaryCount: number;
  /** @deprecated legacy approximate token fields; kept for old readers, not authoritative. */
  selectedOriginalApproxTokens: number;
  selectedCompressedApproxTokens: number;
  estimatedSavedTokens: number;
  projectedTokens: number | null;
  projectedPercent: number | null;
}

export interface LocateQuery {
  ref?: string;
  pattern?: string;
  source?: "any" | "user" | "assistant" | "tool_call" | "tool_result";
  toolName?: string;
  direction?: "oldest" | "newest";
  limit?: number;
  detail?: "brief" | "full";
}

export interface InventoryQuery {
  pageSize?: number;
  cursor?: string;
}

export interface InventoryGroup {
  ref: string;
  label: string;
  isPrefix: boolean;
  startAtomRef: string;
  endAtomRef: string;
  atomCount: number;
  messageCount: number;
  contentChars: number;
  imageCount: number;
  imagePayloadBytes: number;
  imageMimeTypes: string[];
  protectedAtomCount: number;
  compressibleAtomCount: number;
}

export interface InventoryTotals {
  atomCount: number;
  messageCount: number;
  contentChars: number;
  imageCount: number;
  imagePayloadBytes: number;
  groupCount: number;
  protectedAtomCount: number;
  compressibleAtomCount: number;
}

export interface InventoryPiUsage {
  available: boolean;
  contextWindow: number | null;
  tokens: number | null;
  percent: number | null;
  /** Provenance label, e.g. "Pi reported at anchor start". */
  provenance: string;
}

export interface InventoryPage {
  anchor: { transactionId: string; anchorEntryId: string };
  piUsage: InventoryPiUsage;
  totals: InventoryTotals;
  groups: InventoryGroup[];
  nextCursor: string | null;
  pageSize: number;
}

export type ReviewAction =
  | { action: "close" }
  | { action: "edit-summary"; draftId: string }
  | { action: "edit-topic"; draftId: string }
  | { action: "remove"; draftId: string };
