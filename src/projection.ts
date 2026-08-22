// Projection: replaces an exact persisted messageKeys subsequence with a
// midcompact summary message and fails open when a sequence cannot be resolved.
// Owns factual replacement-size calculation based on the actual summary message
// wrapper text, not a fixed token heuristic.

import type { CompressionBlock, CompressionState, ContentMetrics, MessageLike } from "./types.js";
import { aggregateMetrics, measureMessage } from "./content-metrics.js";
import { approxTokens, messageKey } from "./messages.js";

export function summaryMessage(block: CompressionBlock, timestamp = Date.now()): MessageLike {
  const topic = block.topic ? `: ${block.topic}` : "";
  return {
    role: "custom",
    customType: "midcompact-summary",
    content: [
      `[Midcompact summary ${block.id}${topic}]`,
      block.summary,
      "",
      `Original block: ${block.id}`,
      `Use midcompact(action=\"recall\", ref=\"${block.id}\") if exact details are needed.`,
    ].join("\n"),
    display: true,
    details: {
      blockId: block.id,
      originalApproxTokens: block.originalApproxTokens,
      topic: block.topic,
    },
    timestamp,
  } as MessageLike;
}

export function projectMessages(messages: MessageLike[], state?: CompressionState): MessageLike[] {
  if (!state?.blocks.length) return messages;
  const keys = messages.map(messageKey);
  const replacements: Array<{ start: number; end: number; block: CompressionBlock }> = [];
  for (const block of state.blocks) {
    const found = findSubsequence(keys, block.messageKeys);
    if (!found) continue; // fail open: never delete content if the persisted locator no longer resolves exactly
    replacements.push({ start: found.start, end: found.end, block });
  }
  replacements.sort((a, b) => a.start - b.start);
  for (let i = 1; i < replacements.length; i += 1) {
    if (replacements[i]!.start <= replacements[i - 1]!.end) return messages; // corrupted/overlapping state: fail open
  }
  const out = [...messages];
  for (const replacement of [...replacements].reverse()) {
    const first = messages[replacement.start];
    const timestamp = typeof first?.timestamp === "number" ? first.timestamp : Date.now();
    out.splice(replacement.start, replacement.end - replacement.start + 1, summaryMessage(replacement.block, timestamp));
  }
  return out;
}

function findSubsequence(haystack: string[], needle: string[]): { start: number; end: number } | undefined {
  if (needle.length === 0 || needle.length > haystack.length) return undefined;
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return { start, end: start + needle.length - 1 };
  }
  return undefined;
}

/**
 * Measure the actual replacement message produced for a block, so callers can
 * report factual replacement content chars (midcompact wrapper + summary).
 */
export function replacementMetrics(block: CompressionBlock): ContentMetrics {
  return measureMessage(summaryMessage(block));
}

/**
 * Factual replacement content chars for a range, given its topic and summary.
 * Computed from the actual summary message wrapper text that projection emits.
 */
export function replacementContentChars(summary: string, topic?: string): number {
  const block: CompressionBlock = {
    id: "draft",
    summary,
    topic,
    entryIds: [],
    messageKeys: [],
    createdAt: new Date().toISOString(),
    originalContentChars: 0,
    originalImageCount: 0,
    originalImagePayloadBytes: 0,
    replacementContentChars: 0,
    originalApproxTokens: 0,
    compressedApproxTokens: 0,
  };
  return replacementMetrics(block).contentChars;
}

/** @deprecated legacy heuristic; kept only for old approximate-token field compat. */
export function estimateCompressedTokens(summary: string, topic?: string): number {
  return approxTokens(`${topic ?? ""}\n${summary}`) + 40;
}

/** Factual metrics for a set of atoms that a range/block would replace. */
export function rangeMetricsForAtoms(atoms: readonly { metrics: ContentMetrics }[]): ContentMetrics {
  return aggregateMetrics(atoms.map((atom) => atom.metrics));
}
