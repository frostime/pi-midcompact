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

export interface Atom {
  ref: string;
  index: number;
  kind: AtomKind;
  messages: MessageRef[];
  entryIds: string[];
  messageKeys: string[];
  preview: string;
  fullText: string;
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
  originalApproxTokens: number;
  compressedApproxTokens: number;
}

export interface CommitStats {
  transactionId: string;
  committedAt: string;
  addedBlockIds: string[];
  addedRangeCount: number;
  selectedOriginalApproxTokens: number;
  selectedCompressedApproxTokens: number;
  estimatedSavedTokens: number;
  anchorUsage?: ContextUsageSnapshot;
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
  summary: string;
  entryIds: string[];
  messageKeys: string[];
  originalApproxTokens: number;
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

export interface TransactionState {
  version: 1;
  id: string;
  anchorEntryId: string;
  startedAt: string;
  /** Frozen awareness captured when /midcompact starts; informational, never a target. */
  anchorUsage?: ContextUsageSnapshot;
}

export interface DraftTelemetry {
  anchorTokens: number | null;
  contextWindow: number | null;
  anchorPercent: number | null;
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

export type ReviewAction =
  | { action: "close" }
  | { action: "edit-summary"; draftId: string }
  | { action: "edit-topic"; draftId: string }
  | { action: "remove"; draftId: string };
