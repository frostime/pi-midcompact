import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { formatPercent, formatTokenCount } from "./telemetry.js";
import type { Atom, DraftPlan, DraftRange, DraftTelemetry, ReviewAction } from "./types.js";

/**
 * Interactive TUI review. Rendered as a centered overlay (not a full-height
 * editor replacement) so it never flattens the chat transcript. Ranges fold
 * into single header lines; the selected range expands inline with its detail
 * and edit affordances, removing the duplicate top "Selected" block.
 */
export async function showReviewUi(
  ctx: ExtensionCommandContext,
  atoms: Atom[],
  draft: DraftPlan,
  telemetry: DraftTelemetry,
): Promise<ReviewAction> {
  if (ctx.mode !== "tui") return { action: "close" };

  return ctx.ui.custom<ReviewAction>(
    (tui, theme, _keybindings, done) => {
      let scrollOffset = 0;
      let selectedRange = draft.ranges.length ? 0 : -1;
      let expandSelected = true;
      let jumpToSelected = true;

      const selected = (): DraftRange | undefined =>
        selectedRange >= 0 ? draft.ranges[selectedRange] : undefined;

      const component = {
        render(width: number): string[] {
          const w = Math.max(40, width);
          // Conservative height budget: stay under the overlay's maxHeight so
          // the overlay never clips and the chat transcript is not crushed.
          const totalBudget = Math.max(18, Math.floor(tui.terminal.rows * 0.8));
          const border = (text: string) => theme.fg("border", text);
          const dim = (text: string) => theme.fg("dim", text);
          const accent = (text: string) => theme.fg("accent", text);
          const success = (text: string) => theme.fg("success", text);
          const warning = (text: string) => theme.fg("warning", text);
          const inner = Math.max(20, w - 4);
          const framed = (text: string) => `${border("│")} ${truncateToWidth(text, inner, "…", true)} ${border("│")}`;
          const h = (l: string, m = "─", r = "─") => border(`${l}${m.repeat(Math.max(0, w - 2))}${r}`);

          const range = selected();

          const header: string[] = [
            h("╭"),
            framed(accent(theme.bold(`Midcompact Review · Draft v${draft.revision} · ${draft.ranges.length} range(s)`))),
            framed(usageLine(telemetry, theme)),
            h("├"),
          ];

          // Timeline: KEEP atoms always shown; ranges fold to a header line,
          // except the selected range which expands with detail + its atoms.
          const body: string[] = [];
          const rangeStarts = new Map(draft.ranges.map((r) => [r.startIndex, r]));
          const rangeLineStarts = new Map<string, number>();

          for (const atom of atoms) {
            const head = rangeStarts.get(atom.index);
            if (head) {
              rangeLineStarts.set(head.id, body.length);
              const isSel = Boolean(range && range.id === head.id);
              const save = Math.max(0, head.originalApproxTokens - head.compressedApproxTokens);
              const atomCount = head.endIndex - head.startIndex + 1;
              const caret = isSel ? (expandSelected ? "▾" : "▸") : "▸";
              const caretCol = isSel ? accent(caret) : dim(caret);
              const idCol = isSel ? theme.bold(warning(head.id)) : warning(head.id);
              const span = dim(`${head.startRef}→${head.endRef} · ${atomCount} atoms`);
              const tok = dim(`~${formatTokenCount(head.originalApproxTokens)}→~${formatTokenCount(head.compressedApproxTokens)}`);
              const saveCol = success(`save ~${formatTokenCount(save)}`);
              const topicCol = head.topic ? `${accent(head.topic)} ` : "";
              const sumCol = dim(firstLine(head.summary, 48));
              const headText = `${caretCol} ${idCol} ${span} ${tok} ${saveCol} ${topicCol}${sumCol}`;
              body.push(framed(isSel ? accent(headText) : headText));

              if (isSel) {
                body.push(framed(dim(`  topic: ${head.topic ?? "—"}`)));
                body.push(framed(dim(`  tokens: ~${formatTokenCount(head.originalApproxTokens)} → ~${formatTokenCount(head.compressedApproxTokens)} (save ~${formatTokenCount(save)})`)));
                const wrapWidth = Math.max(10, inner - 6);
                for (const line of wrapTextWithAnsi(`${accent("summary:")} ${head.summary}`, wrapWidth)) {
                  body.push(framed(`  ${line}`));
                }
                body.push(framed(dim(`  [e] edit summary · [t] edit topic · [d] remove · [x] ${expandSelected ? "collapse" : "expand"} atoms`)));
              }
            }

            const owner = owningRange(atom.index, draft.ranges);
            const showAtom = !owner || (Boolean(range) && owner.id === range!.id && expandSelected);
            if (!showAtom) continue;

            const mark = owner
              ? atom.index === owner.startIndex
                ? "┌"
                : atom.index === owner.endIndex
                  ? "└"
                  : "│"
              : " ";
            const policy = owner ? warning(owner.id) : success("KEEP");
            const tok = dim(`~${formatTokenCount(atom.approxTokens)}`);
            const oneLine = dim(firstLine(atom.preview, 80));
            body.push(framed(`${mark} ${policy} ${atom.ref} [${atom.kind}] ${tok}  ${oneLine}`));
          }
          if (!body.length) body.push(framed(dim("(No atoms in anchor snapshot.)")));

          const footer: string[] = [
            h("├"),
            framed(dim(`ranges ${hint("n/p", theme)} · scroll ${hint("↑↓ PgUp PgDn", theme)} · ${hint("Esc", theme)} close`)),
            framed(dim(`selected: ${hint("e", theme)} summary · ${hint("t", theme)} topic · ${hint("d", theme)} remove · ${hint("x", theme)} expand`)),
            h("╰"),
          ];

          const viewportHeight = Math.max(5, totalBudget - header.length - footer.length);
          if (jumpToSelected && range) {
            const target = rangeLineStarts.get(range.id) ?? 0;
            scrollOffset = Math.max(0, target - 2);
            jumpToSelected = false;
          }
          const maxOffset = Math.max(0, body.length - viewportHeight);
          scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
          const visible = body.slice(scrollOffset, scrollOffset + viewportHeight);
          while (visible.length < viewportHeight) visible.push(framed(""));

          return [...header, ...visible, ...footer];
        },
        invalidate(): void {},
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") {
            done({ action: "close" });
            return;
          }
          if ((data === "n" || matchesKey(data, Key.right)) && draft.ranges.length) {
            selectedRange = (selectedRange + 1 + draft.ranges.length) % draft.ranges.length;
            expandSelected = true;
            jumpToSelected = true;
            tui.requestRender();
            return;
          }
          if ((data === "p" || matchesKey(data, Key.left)) && draft.ranges.length) {
            selectedRange = (selectedRange - 1 + draft.ranges.length) % draft.ranges.length;
            expandSelected = true;
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
    },
    { overlay: true, overlayOptions: { width: "92%", maxHeight: "86%", anchor: "center" } },
  );
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
    lines.push(`${owner ? owner.id : "KEEP"} ${atom.ref} [${atom.kind}] ~${formatTokenCount(atom.approxTokens)} ${firstLine(atom.preview, 120)}`);
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

function firstLine(text: string, limit = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function hint(text: string, theme: ExtensionCommandContext["ui"]["theme"]): string {
  return theme.fg("accent", text);
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

function usageLine(telemetry: DraftTelemetry, theme: ExtensionCommandContext["ui"]["theme"]): string {
  return `${theme.fg("accent", "Context")}: ${plainUsageLine(telemetry)}`;
}
