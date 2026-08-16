import type { ContextUsageSnapshot, DraftPlan, DraftTelemetry, TransactionState } from "./types.js";

interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export function snapshotContextUsage(usage: ContextUsageLike | undefined): ContextUsageSnapshot | undefined {
  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return undefined;
  return {
    tokens: typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? Math.max(0, Math.round(usage.tokens)) : null,
    contextWindow: Math.max(1, Math.round(usage.contextWindow)),
    percent: typeof usage.percent === "number" && Number.isFinite(usage.percent) ? usage.percent : null,
    capturedAt: new Date().toISOString(),
  };
}

export function draftTelemetry(transaction: TransactionState | undefined, draft: DraftPlan | undefined): DraftTelemetry {
  const ranges = draft?.ranges ?? [];
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
    anchorTokens,
    contextWindow,
    anchorPercent,
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

export function formatTelemetry(telemetry: DraftTelemetry): string {
  const lines = ["Context awareness (informational, not a target):"];
  if (telemetry.contextWindow !== null) {
    lines.push(
      `anchor: ${formatTokenCount(telemetry.anchorTokens)} / ${formatTokenCount(telemetry.contextWindow)} (${formatPercent(telemetry.anchorPercent)})`,
    );
  } else {
    lines.push("anchor: Pi context usage unavailable");
  }
  lines.push(
    `draft selection: ~${formatTokenCount(telemetry.selectedOriginalApproxTokens)} → ~${formatTokenCount(telemetry.selectedCompressedApproxTokens)} (save ~${formatTokenCount(telemetry.estimatedSavedTokens)})`,
  );
  if (telemetry.contextWindow !== null && telemetry.projectedTokens !== null) {
    lines.push(
      `projected if committed now: ~${formatTokenCount(telemetry.projectedTokens)} / ${formatTokenCount(telemetry.contextWindow)} (${formatPercent(telemetry.projectedPercent, true)})`,
    );
  } else {
    lines.push("projected total: unavailable until Pi reports anchor usage");
  }
  return lines.join("\n");
}

function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
