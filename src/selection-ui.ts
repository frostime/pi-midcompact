import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { Atom, DraftPlan, DraftTelemetry, SelectionSpan } from "./types.js";

export interface SelectionUiAction {
  action: "save" | "close";
  spans?: SelectionSpan[];
  keepRefs?: string[];
}

/**
 * Atom-level Selection surface. It edits a requested selection only; the
 * caller normalizes it into ordinary DraftRanges through the shared core.
 */
export async function showSelectionUi(
  ctx: ExtensionCommandContext,
  atoms: Atom[],
  draft: DraftPlan,
  telemetry: DraftTelemetry,
): Promise<SelectionUiAction> {
  if (ctx.mode !== "tui") return { action: "close" };

  return ctx.ui.custom(
    (tui: { terminal: { rows: number }; requestRender: () => void }, theme: any, _keybindings: unknown, done: (action: SelectionUiAction) => void) => {
      const selected = new Set<number>();
      const keep = new Set<string>();
      let cursor = 0;
      let scrollOffset = 0;
      let dirty = false;

      for (const range of draft.ranges) {
        for (let index = range.startIndex; index <= range.endIndex; index += 1) selected.add(index);
      }

      const dim = (text: string) => theme.fg("dim", text);
      const accent = (text: string) => theme.fg("accent", text);
      const success = (text: string) => theme.fg("success", text);
      const warning = (text: string) => theme.fg("warning", text);
      const border = (text: string) => theme.fg("border", text);
      const widthOf = (width: number) => Math.max(40, width);
      const frame = (text: string, width: number) => `${border("|")} ${truncateToWidth(text, Math.max(20, width - 4), "...", true)} ${border("|")}`;
      const rule = (width: number, left: string, right: string) => border(`${left}${"-".repeat(Math.max(0, width - 2))}${right}`);
      const short = (text: string, limit: number) => {
        const normalized = text.replace(/\s+/g, " ").trim();
        return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}...`;
      };
      const groupBounds = (index: number): { start: number; end: number } => {
        let start = index;
        while (start > 0 && atoms[start]?.kind !== "user") start -= 1;
        if (atoms[start]?.kind !== "user" && start === 0) start = 0;
        let end = index;
        while (end + 1 < atoms.length && atoms[end + 1]?.kind !== "user") end += 1;
        return { start, end };
      };
      const spans = (): SelectionSpan[] => {
        const indices = [...selected].sort((a, b) => a - b);
        const result: SelectionSpan[] = [];
        for (const index of indices) {
          const previous = result[result.length - 1];
          const previousIndex = previous ? atoms.findIndex((atom) => atom.ref === previous.endRef) : -2;
          if (previous && previousIndex + 1 === index) previous.endRef = atoms[index]!.ref;
          else result.push({ startRef: atoms[index]!.ref, endRef: atoms[index]!.ref });
        }
        return result;
      };
      const toggleSelection = () => {
        const atom = atoms[cursor];
        if (!atom) return;
        if (!atom.compressible && !selected.has(cursor)) {
          ctx.ui.notify(`Protected atom ${atom.ref} stays KEEP. Select its surrounding group instead.`, "warning");
          return;
        }
        if (selected.has(cursor)) {
          selected.delete(cursor);
          keep.delete(atom.ref);
        } else selected.add(cursor);
        dirty = true;
        tui.requestRender();
      };
      const toggleKeep = () => {
        const atom = atoms[cursor];
        if (!atom) return;
        if (!atom.compressible) {
          ctx.ui.notify(`Protected atom ${atom.ref} already stays KEEP.`, "info");
          return;
        }
        if (!selected.has(cursor)) {
          selected.add(cursor);
          keep.add(atom.ref);
          dirty = true;
          tui.requestRender();
          return;
        }
        if (keep.has(atom.ref)) keep.delete(atom.ref);
        else keep.add(atom.ref);
        dirty = true;
        tui.requestRender();
      };
      const addGroup = () => {
        const bounds = groupBounds(cursor);
        for (let index = bounds.start; index <= bounds.end; index += 1) selected.add(index);
        dirty = true;
        tui.requestRender();
      };
      const clearRange = () => {
        const current = atoms[cursor];
        if (!current?.compressible || keep.has(current.ref) || !selected.has(cursor)) return;
        let start = cursor;
        let end = cursor;
        while (start > 0 && atoms[start - 1]!.compressible && selected.has(start - 1) && !keep.has(atoms[start - 1]!.ref)) start -= 1;
        while (end + 1 < atoms.length && atoms[end + 1]!.compressible && selected.has(end + 1) && !keep.has(atoms[end + 1]!.ref)) end += 1;
        for (let index = start; index <= end; index += 1) {
          selected.delete(index);
          keep.delete(atoms[index]!.ref);
        }
        dirty = true;
        tui.requestRender();
      };
      const move = (delta: number) => {
        cursor = Math.max(0, Math.min(atoms.length - 1, cursor + delta));
        tui.requestRender();
      };

      const component = {
        render(width: number): string[] {
          const w = widthOf(width);
          const budget = Math.max(18, Math.floor(tui.terminal.rows * 0.82));
          const selectedAtoms = [...selected].map((index) => atoms[index]).filter(Boolean) as Atom[];
          const chars = selectedAtoms.reduce((sum, atom) => sum + atom.metrics.contentChars, 0);
          const images = selectedAtoms.reduce((sum, atom) => sum + atom.metrics.imageCount, 0);
          const body: string[] = [];
          const lineStarts = new Map<number, number>();
          let groupNumber = 0;

          atoms.forEach((atom, index) => {
            if (atom.kind === "user") groupNumber += 1;
            if (index === 0 || atom.kind === "user") {
              const groupRef = atom.kind === "user" ? `g${String(groupNumber).padStart(4, "0")}` : "g0000";
              const label = atom.kind === "user" ? short(atom.preview, Math.max(24, w - 24)) : "context before first user message";
              body.push(frame(accent(`-- ${groupRef} | ${label}`), w));
            }
            lineStarts.set(index, body.length);
            const isCursor = index === cursor;
            const isSelected = selected.has(index);
            const isKeep = keep.has(atom.ref) || !atom.compressible;
            const marker = isKeep ? "K" : isSelected ? "*" : " ";
            const state = isKeep ? success("KEEP") : isSelected ? warning("PLAN") : dim("....");
            const tools = atom.toolNames.length ? ` tools:${atom.toolNames.join(",")}` : "";
            const line = `${isCursor ? ">" : " "} [${marker}] ${atom.ref} ${atom.kind.padEnd(15)} ${String(atom.metrics.contentChars).padStart(6)} chars ${String(atom.metrics.imageCount).padStart(2)} img ${tools}`;
            body.push(frame(isCursor ? accent(line) : state + " " + line.slice(2), w));
            const preview = short(atom.preview, Math.max(30, w - 24));
            for (const wrapped of wrapTextWithAnsi(`    ${preview}`, Math.max(20, w - 8)).slice(0, 2)) body.push(frame(dim(wrapped), w));
          });

          const header = [
            rule(w, "+", "+"),
            frame(accent(theme.bold(`Midcompact Selection | Draft v${draft.revision}`)), w),
            frame(dim(`Anchor Pi usage: ${usageLine(telemetry)} | selected ${selected.size} atoms | ${chars} chars | ${images} images`), w),
            rule(w, "+", "+"),
          ];
          const footer = [
            rule(w, "+", "+"),
            frame(dim("j/k move | space select | K KEEP | G add group | D remove range | S save | Esc save & close"), w),
            frame(dim(`requested spans ${spans().length} | keep ${keep.size} | ${selected.size} selected`), w),
            rule(w, "+", "+"),
          ];
          const viewport = Math.max(4, budget - header.length - footer.length);
          const cursorLine = lineStarts.get(cursor) ?? 0;
          if (cursorLine < scrollOffset) scrollOffset = cursorLine;
          else if (cursorLine >= scrollOffset + viewport) scrollOffset = cursorLine - viewport + 1;
          scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, body.length - viewport)));
          const visible = body.slice(scrollOffset, scrollOffset + viewport);
          while (visible.length < viewport) visible.push(frame("", w));
          return [...header, ...visible, ...footer];
        },
        invalidate(): void {},
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape) || data === "q") {
            done(dirty ? { action: "save", spans: spans(), keepRefs: [...keep] } : { action: "close" });
            return;
          }
          if (data === "s" || data === "S" || matchesKey(data, Key.enter)) {
            done({ action: "save", spans: spans(), keepRefs: [...keep] });
            return;
          }
          if (data === "j" || matchesKey(data, Key.down)) move(1);
          else if (data === "k" || matchesKey(data, Key.up)) move(-1);
          else if (data === " " || data === "x") toggleSelection();
          else if (data === "K") toggleKeep();
          else if (data === "g" || data === "G") addGroup();
          else if (data === "d" || data === "D") clearRange();
          else if (matchesKey(data, Key.pageDown)) { scrollOffset += 10; tui.requestRender(); }
          else if (matchesKey(data, Key.pageUp)) { scrollOffset = Math.max(0, scrollOffset - 10); tui.requestRender(); }
        },
      };
      return component;
    },
    { overlay: true, overlayOptions: { width: "94%", maxHeight: "88%", anchor: "center" } },
  ) as Promise<SelectionUiAction>;
}

function usageLine(telemetry: DraftTelemetry): string {
  const usage = telemetry.anchorUsage;
  if (!usage) return "unavailable";
  const tokens = usage.tokens === null ? "unavailable" : String(usage.tokens);
  const percent = usage.percent === null ? "unavailable" : `${usage.percent}%`;
  return `${tokens}/${usage.contextWindow} tokens (${percent}, Pi reported)`;
}
