import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

import { STATE_ENTRY } from "./state.js";
import { formatPercent, formatTokenCount } from "./telemetry.js";
import type { CompressionState } from "./types.js";

export function registerStateRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<CompressionState>(STATE_ENTRY, (entry, { expanded }, theme) => {
    const state = entry.data;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    if (!state) {
      box.addChild(new Text(theme.fg("dim", "[midcompact] state unavailable"), 0, 0));
      return box;
    }
    const commit = state.lastCommit;
    const originalChars = state.blocks.reduce((sum, block) => sum + (block.originalContentChars ?? 0), 0);
    const replacementChars = state.blocks.reduce((sum, block) => sum + (block.replacementContentChars ?? 0), 0);
    const imageCount = state.blocks.reduce((sum, block) => sum + (block.originalImageCount ?? 0), 0);
    const added = commit?.addedRangeCount ?? 0;
    const headline = [
      theme.fg("success", "✓ MIDCOMPACT"),
      added ? `+${added} range${added === 1 ? "" : "s"}` : `${state.blocks.length} active block${state.blocks.length === 1 ? "" : "s"}`,
      `${state.blocks.length} active`,
      `${originalChars} → ${replacementChars} content chars`,
      imageCount ? `${imageCount} images` : "",
    ].filter(Boolean).join(" · ");
    box.addChild(new Text(headline, 0, 0));

    if (commit?.anchorUsage?.contextWindow) {
      // Pi-reported awareness only; no local projected token percentage claim.
      box.addChild(new Text(
        theme.fg(
          "dim",
          `anchor ${formatPercent(commit.anchorUsage.percent)} [Pi reported] · ${commit.selectedOriginalContentChars} → ${commit.selectedReplacementContentChars} chars · ${commit.selectedImageCount} images`,
        ),
        0, 0,
      ));
    }

    if (expanded) {
      const addedSet = new Set(commit?.addedBlockIds ?? []);
      const blocks = addedSet.size ? state.blocks.filter((block) => addedSet.has(block.id)) : state.blocks;
      for (const block of blocks) {
        const title = `${block.id}${block.topic ? ` · ${block.topic}` : ""} · ${block.originalContentChars ?? 0} → ${block.replacementContentChars ?? 0} chars${block.originalImageCount ? ` · ${block.originalImageCount} images` : ""}`;
        box.addChild(new Text(theme.fg("accent", title), 0, 0));
        box.addChild(new Text(theme.fg("dim", block.summary), 1, 0));
      }
      box.addChild(new Text(theme.fg("dim", "Original history retained; use midcompact recall when exact details are needed."), 0, 0));
    }
    return box;
  });
}

export function stateTreeLabel(state: CompressionState): string {
  const commit = state.lastCommit;
  const added = commit?.addedRangeCount ?? 0;
  const replacementChars = state.blocks.reduce((sum, block) => sum + (block.replacementContentChars ?? 0), 0);
  const originalChars = state.blocks.reduce((sum, block) => sum + (block.originalContentChars ?? 0), 0);
  const anchor = commit?.anchorUsage?.percent === null || commit?.anchorUsage?.percent === undefined
    ? ""
    : ` · anchor ${formatPercent(commit.anchorUsage.percent)} [Pi]`;
  return `midcompact${added ? ` +${added}` : ""} · ${originalChars} → ${replacementChars} chars${anchor}`;
}
