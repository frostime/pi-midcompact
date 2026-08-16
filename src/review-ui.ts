import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { formatPercent, formatTokenCount } from "./telemetry.js";
import type { Atom, DraftPlan, DraftRange, DraftTelemetry, ReviewAction } from "./types.js";

export async function showReviewUi(
  ctx: ExtensionCommandContext,
  atoms: Atom[],
  draft: DraftPlan,
  telemetry: DraftTelemetry,
): Promise<ReviewAction> {
  if (ctx.mode !== "tui") return { action: "close" };

  return ctx.ui.custom<ReviewAction>((tui, theme, _keybindings, done) => {
    let scrollOffset = 0;
    let selectedRange = draft.ranges.length ? 0 : -1;
    let expandSelected = false;
    let jumpToSelected = true;

    const selected = (): DraftRange | undefined => selectedRange >= 0 ? draft.ranges[selectedRange] : undefined;

    const component = {
      render(width: number): string[] {
        const w = Math.max(30, width);
        const rows = Math.max(12, tui.terminal.rows);
        const border = (text: string) => theme.fg("border", text);
        const dim = (text: string) => theme.fg("dim", text);
        const accent = (text: string) => theme.fg("accent", text);
        const success = (text: string) => theme.fg("success", text);
        const warning = (text: string) => theme.fg("warning", text);
        const bodyWidth = Math.max(20, w - 4);
        const framed = (text: string) => `${border("│")} ${truncateToWidth(text, bodyWidth, "…", true)} ${border("│")}`;
        const horizontal = (left: string, mid = "─", right = "─") => border(`${left}${mid.repeat(Math.max(0, w - 2))}${right}`);

        const header: string[] = [];
        header.push(horizontal("╭", "─", "╮"));
        header.push(framed(accent(theme.bold(`Midcompact Review · Draft v${draft.revision}`))));
        header.push(framed(formatUsageLine(telemetry, theme)));
        header.push(framed(dim("This is awareness, not a target. Review the linear anchor snapshot before /midcompact commit.")));
        header.push(horizontal("├", "─", "┤"));

        const range = selected();
        const selectedInfo: string[] = [];
        if (range) {
          selectedInfo.push(framed(`${accent("Selected")} ${range.id}  ${range.startRef} → ${range.endRef}${range.topic ? `  ${range.topic}` : ""}`));
          selectedInfo.push(framed(dim(`~${formatTokenCount(range.originalApproxTokens)} → ~${formatTokenCount(range.compressedApproxTokens)} tokens`)));
          for (const line of wrapTextWithAnsi(`${accent("Summary:")} ${range.summary}`, bodyWidth)) selectedInfo.push(framed(line));
          selectedInfo.push(horizontal("├", "─", "┤"));
        }

        const body: string[] = [];
        const atomLineStarts = new Map<number, number>();
        for (const atom of atoms) {
          atomLineStarts.set(atom.index, body.length);
          const owner = owningRange(atom.index, draft.ranges);
          const isSelected = Boolean(range && owner?.id === range.id);
          const isRangeStart = owner?.startIndex === atom.index;
          const isRangeEnd = owner?.endIndex === atom.index;
          const rangeMark = owner ? (isRangeStart ? "┌" : isRangeEnd ? "└" : "│") : " ";
          const selectionMark = isSelected ? "▶" : " ";
          const policy = owner ? warning(owner.id) : success("KEEP");
          const token = dim(`~${formatTokenCount(atom.approxTokens)}`);
          const oneLine = firstLine(atom.preview);
          body.push(framed(`${selectionMark}${rangeMark} ${policy} ${atom.ref} [${atom.kind}] ${token}  ${oneLine}`));
          if (expandSelected && isSelected) {
            const detail = wrapTextWithAnsi(atom.preview, Math.max(10, bodyWidth - 4));
            for (const detailLine of detail.slice(1, 8)) body.push(framed(dim(`    ${detailLine}`)));
          }
        }
        if (!body.length) body.push(framed(dim("(No atoms in anchor snapshot.)")));

        const footerRows = 4;
        const viewportHeight = Math.max(5, rows - header.length - selectedInfo.length - footerRows - 2);
        if (jumpToSelected && range) {
          scrollOffset = atomLineStarts.get(range.startIndex) ?? scrollOffset;
          jumpToSelected = false;
        }
        const maxOffset = Math.max(0, body.length - viewportHeight);
        scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
        const visible = body.slice(scrollOffset, scrollOffset + viewportHeight);
        while (visible.length < viewportHeight) visible.push(framed(""));

        const top = body.length ? scrollOffset + 1 : 0;
        const bottom = Math.min(body.length, scrollOffset + viewportHeight);
        const footer = [
          horizontal("├", "─", "┤"),
          framed(dim(`Lines ${top}-${bottom} of ${body.length} · n/p select range · ↑↓/PgUp/PgDn scroll · x expand selected`)),
          framed(dim("e edit summary · t edit topic · d remove selected range · Enter/Esc close")),
          horizontal("╰", "─", "╯"),
        ];
        return [...header, ...selectedInfo, ...visible, ...footer];
      },
      invalidate(): void {},
      handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") {
          done({ action: "close" });
          return;
        }
        if ((data === "n" || matchesKey(data, Key.right)) && draft.ranges.length) {
          selectedRange = (selectedRange + 1 + draft.ranges.length) % draft.ranges.length;
          jumpToSelected = true;
          tui.requestRender();
          return;
        }
        if ((data === "p" || matchesKey(data, Key.left)) && draft.ranges.length) {
          selectedRange = (selectedRange - 1 + draft.ranges.length) % draft.ranges.length;
          jumpToSelected = true;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.up) || data === "k") {
          scrollOffset = Math.max(0, scrollOffset - 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.down) || data === "j") {
          scrollOffset += 1;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.pageUp)) {
          scrollOffset = Math.max(0, scrollOffset - 12);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.pageDown)) {
          scrollOffset += 12;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.home)) {
          scrollOffset = 0;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.end)) {
          scrollOffset = Number.MAX_SAFE_INTEGER;
          tui.requestRender();
          return;
        }
        if (data === "x") {
          expandSelected = !expandSelected;
          jumpToSelected = true;
          tui.requestRender();
          return;
        }
        const range = selected();
        if (!range) return;
        if (data === "e") done({ action: "edit-summary", draftId: range.id });
        else if (data === "t") done({ action: "edit-topic", draftId: range.id });
        else if (data === "d") done({ action: "remove", draftId: range.id });
      },
    };
    return component;
  });
}

export function buildReviewText(atoms: Atom[], draft: DraftPlan, telemetry: DraftTelemetry): string {
  const lines = [
    `Midcompact Review · Draft v${draft.revision}`,
    plainUsageLine(telemetry),
    "This is awareness, not a target.",
    "",
  ];
  for (const atom of atoms) {
    const owner = owningRange(atom.index, draft.ranges);
    lines.push(`${owner ? owner.id : "KEEP"} ${atom.ref} [${atom.kind}] ~${formatTokenCount(atom.approxTokens)} ${firstLine(atom.preview)}`);
  }
  if (draft.ranges.length) {
    lines.push("", "Proposed summaries:");
    for (const range of draft.ranges) lines.push(`${range.id} ${range.startRef} → ${range.endRef}: ${range.summary}`);
  }
  return lines.join("\n");
}

function owningRange(atomIndex: number, ranges: DraftRange[]): DraftRange | undefined {
  return ranges.find((range) => atomIndex >= range.startIndex && atomIndex <= range.endIndex);
}

function firstLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function plainUsageLine(telemetry: DraftTelemetry): string {
  const anchor = telemetry.contextWindow === null
    ? "anchor usage unavailable"
    : `${formatTokenCount(telemetry.anchorTokens)}/${formatTokenCount(telemetry.contextWindow)} (${formatPercent(telemetry.anchorPercent)})`;
  const projected = telemetry.projectedTokens === null || telemetry.contextWindow === null
    ? "projected unavailable"
    : `~${formatTokenCount(telemetry.projectedTokens)}/${formatTokenCount(telemetry.contextWindow)} (${formatPercent(telemetry.projectedPercent, true)})`;
  return `Anchor ${anchor} · Draft selected ~${formatTokenCount(telemetry.selectedOriginalApproxTokens)}→~${formatTokenCount(telemetry.selectedCompressedApproxTokens)} · Projected ${projected}`;
}

function formatUsageLine(telemetry: DraftTelemetry, theme: ExtensionCommandContext["ui"]["theme"]): string {
  const label = theme.fg("accent", "Context");
  return `${label}: ${plainUsageLine(telemetry)}`;
}
