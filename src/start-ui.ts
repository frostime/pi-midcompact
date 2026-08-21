import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import type { StartMode } from "./types.js";

export type StartChoice = StartMode | "cancelled";

export async function showStartChoiceUi(ctx: ExtensionCommandContext): Promise<StartChoice> {
  if (ctx.mode !== "tui") return "agent";
  return ctx.ui.custom<StartChoice>(
    (tui, theme, _keybindings, done) => {
      const choices: Array<{ value: StartChoice; title: string; detail: string }> = [
        { value: "cancelled", title: "Drop", detail: "Leave the session unchanged" },
        { value: "agent", title: "Agent direct", detail: "Inspect and draft with Agent" },
        { value: "user", title: "User manual", detail: "Select the initial DraftPlan yourself" },
      ];
      let selected = 1;
      const component = {
        render(width: number): string[] {
          const w = Math.max(48, Math.min(width, 94));
          const line = (text: string) => theme.fg("border", `| ${truncateToWidth(text, w - 4, "...", true).padEnd(w - 4)} |`);
          const rule = theme.fg("border", `+${"-".repeat(w - 2)}+`);
          const rows = choices.map((choice, index) => {
            const marker = index === selected ? theme.fg("accent", ">") : " ";
            const rawTitle = choice.title.padEnd(18);
            const title = index === selected ? theme.fg("accent", theme.bold(rawTitle)) : rawTitle;
            return line(`${marker} ${String(index + 1)}  ${title} ${theme.fg("dim", choice.detail)}`);
          });
          return [
            rule,
            line(theme.fg("accent", theme.bold("Midcompact | Freeze current context"))),
            line(theme.fg("dim", "Choose how to enter. Only Agent direct starts a model turn.")),
            rule,
            ...rows,
            rule,
            line(theme.fg("dim", "left/right or j/k move | Enter choose | Esc drop")),
            rule,
          ];
        },
        invalidate(): void {},
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape) || data === "q") { done("cancelled"); return; }
          if (matchesKey(data, Key.enter)) { done(choices[selected]!.value); return; }
          if (data === "1") { done("cancelled"); return; }
          if (data === "2") { done("agent"); return; }
          if (data === "3") { done("user"); return; }
          if (matchesKey(data, Key.left) || matchesKey(data, Key.up) || data === "k") selected = (selected + choices.length - 1) % choices.length;
          else if (matchesKey(data, Key.right) || matchesKey(data, Key.down) || data === "j") selected = (selected + 1) % choices.length;
          else return;
          tui.requestRender();
        },
      };
      return component;
    },
    { overlay: true, overlayOptions: { width: "76%", maxHeight: 13, anchor: "center" } },
  );
}
