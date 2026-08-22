// Telemetry presentation. Owns Pi-reported usage formatting and factual
// char/image aggregation. Agent-facing output no longer presents local
// character-count-derived token estimates or projected token percentages as
// authoritative figures. Legacy approximate-token fields remain computable for
// backward-compatible readers but are not shown in new Agent-facing output.

import type { ContextUsageSnapshot, DraftPlan, DraftTelemetry, TransactionState } from "./types.js";

export function snapshotContextUsage(usage: {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
} | undefined): ContextUsageSnapshot | undefined {
  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return undefined;
  return {
    tokens: typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? Math.max(0, Math.round(usage.tokens)) : null,
    contextWindow: Math.max(1, Math.round(usage.contextWindow)),
    percent: typeof usage.percent === "number" && Number.isFinite(usage.percent) ? usage.percent : null,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Build draft telemetry. The factual char/image fields are authoritative for
 * new output; legacy approximate-token fields are kept only for old readers.
 */
export function draftTelemetry(
  transaction: TransactionState | undefined,
  draft: DraftPlan | undefined,
): DraftTelemetry {
  const ranges = draft?.ranges ?? [];
  let selectedOriginalContentChars = 0;
  let selectedReplacementContentChars = 0;
  let selectedImageCount = 0;
  let selectedImagePayloadBytes = 0;
  let pendingSummaryCount = 0;
  for (const range of ranges) {
    selectedOriginalContentChars += range.originalContentChars;
    selectedReplacementContentChars += range.replacementContentChars;
    selectedImageCount += range.originalImageCount;
    selectedImagePayloadBytes += range.originalImagePayloadBytes;
    if (range.summary.trim().length === 0) pendingSummaryCount += 1;
  }
  // Legacy approximate-token sums, kept for backward-compatible readers only.
  const selectedOriginalApproxTokens = ranges.reduce((sum, range) => sum + range.originalApproxTokens, 0);
  const selectedCompressedApproxTokens = ranges.reduce((sum, range) => sum + range.compressedApproxTokens, 0);
  const estimatedSavedTokens = Math.max(0, selectedOriginalApproxTokens - selectedCompressedApproxTokens);
  const anchorTokens = transaction?.anchorUsage?.tokens ?? null;
  const contextWindow = transaction?.anchorUsage?.contextWindow ?? null;
  const anchorPercent = transaction?.anchorUsage?.percent ?? null;
  const projectedTokens = anchorTokens === null ? null : Math.max(0, anchorTokens - estimatedSavedTokens);
  const projectedPercent = projectedTokens === null || contextWindow === null || contextWindow <= 0
    ? null
    : (projectedTokens / contextWindow) * 100;
  return {
    anchorUsage: transaction?.anchorUsage,
    contextWindow,
    anchorTokens,
    anchorPercent,
    selectedOriginalContentChars,
    selectedReplacementContentChars,
    selectedImageCount,
    selectedImagePayloadBytes,
    rangeCount: ranges.length,
    pendingSummaryCount,
    selectedOriginalApproxTokens,
    selectedCompressedApproxTokens,
    estimatedSavedTokens,
    projectedTokens,
    projectedPercent,
  };
}

export function formatTokenCount(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens)) return "?";
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000) return `${trim(tokens / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

export function formatPercent(percent: number | null, approximate = false): string {
  if (percent === null || !Number.isFinite(percent)) return "?";
  return `${approximate ? "~" : ""}${trim(percent)}%`;
}

/**
 * Agent-facing awareness summary. Presents Pi-reported usage (labelled as such)
 * and factual char/image stats only. No local token-savings or projected-token-
 * percentage claims.
 */
export function formatTelemetry(telemetry: DraftTelemetry): string {
  const lines = ["Context awareness (Pi reported; informational, not a target):"];
  const usage = telemetry.anchorUsage;
  if (usage?.contextWindow) {
    lines.push(
      `anchor: ${formatTokenCount(usage.tokens)} / ${formatTokenCount(usage.contextWindow)} (${formatPercent(usage.percent)}) [Pi reported]`,
    );
  } else {
    lines.push("anchor: Pi context usage unavailable [Pi reported; not derived from local char counts].");
  }
  lines.push(
    `draft: ${telemetry.rangeCount} range(s) · ${telemetry.selectedOriginalContentChars} → ${telemetry.selectedReplacementContentChars} content chars · ${telemetry.selectedImageCount} images (${telemetry.selectedImagePayloadBytes} payload bytes) · ${telemetry.pendingSummaryCount} pending summary`,
  );
  return lines.join("\n");
}

function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
