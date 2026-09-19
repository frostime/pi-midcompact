import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type PlanningSurface = "tui" | "webui";
export type PlanningSurfaceRequest = PlanningSurface | "choose";

export interface ParsedSurfaceRequest {
  request?: PlanningSurfaceRequest;
  usage?: string;
}

interface SurfaceChoiceOption {
  value?: PlanningSurface;
  label: string;
}

const SURFACE_CHOICES: SurfaceChoiceOption[] = [
  { value: "webui", label: "Web UI — Recommended" },
  { value: "tui", label: "TUI — Built into Pi" },
  { label: "Cancel" },
];

const SURFACE_DIALOG_TIMEOUT_MS = 120_000;

export function parseSurfaceRequest(args: string, command: "select" | "review"): ParsedSurfaceRequest {
  const argument = args.trim().toLowerCase();
  if (!argument) return { request: "choose" };
  if (argument === "tui" || argument === "webui") return { request: argument };
  return { usage: `Usage: /midcompact:${command} [tui|webui]` };
}

export async function resolvePlanningSurface(
  ctx: ExtensionCommandContext,
  request: PlanningSurfaceRequest,
  command: "select" | "review",
): Promise<PlanningSurface | undefined> {
  let surface: PlanningSurface | undefined;

  if (request === "choose") {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `No interactive UI is available to choose a ${command} surface. Specify /midcompact:${command} tui or /midcompact:${command} webui.`,
        "warning",
      );
      return undefined;
    }

    const labels = SURFACE_CHOICES.map((choice) => choice.label);
    const selected = await ctx.ui.select(
      `Open Midcompact ${command === "select" ? "Selection" : "Review"}`,
      labels,
      ctx.mode === "rpc" ? { timeout: SURFACE_DIALOG_TIMEOUT_MS } : undefined,
    );
    if (selected === undefined || selected === SURFACE_CHOICES[2]!.label) {
      ctx.ui.notify(`Midcompact ${command} opening cancelled.`, "info");
      return undefined;
    }
    surface = SURFACE_CHOICES.find((choice) => choice.label === selected)?.value;
    if (!surface) {
      ctx.ui.notify(`Midcompact ${command} was not opened: the dialog returned an unrecognized choice.`, "warning");
      return undefined;
    }
  } else {
    surface = request;
  }

  if (surface === "tui" && ctx.mode !== "tui") {
    ctx.ui.notify(
      `The TUI ${command} surface is only available in interactive (tui) mode. Use /midcompact:${command} webui instead.`,
      "warning",
    );
    return undefined;
  }
  return surface;
}
