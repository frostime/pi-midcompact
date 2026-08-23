import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { StartMode } from "./types.js";

export type StartChoice = StartMode | "cancelled";

interface StartChoiceOption {
  value: StartChoice;
  label: string;
}

/**
 * The three entry decisions. Shared by TUI and RPC so every mode offers the
 * same choice set in the same order through the standard `select` dialog.
 */
const START_CHOICES: StartChoiceOption[] = [
  { value: "cancelled", label: "Drop — Leave the session unchanged" },
  { value: "agent", label: "Agent direct — Inspect and draft with Agent" },
  { value: "user", label: "User manual — Select the initial DraftPlan yourself" },
];

/**
 * Bound for RPC dialog waits. When the RPC client never answers, the
 * extension-UI sub-protocol auto-resolves the dialog (`undefined`), so the
 * start command cancels instead of blocking the extension forever. TUI mode
 * does not pass a timeout: interactive users may take as long as they want.
 */
const START_DIALOG_TIMEOUT_MS = 120_000;

/**
 * Standard `select` dialog for the start mode, used identically in TUI and
 * RPC. It serializes as an extension UI `select` request over the RPC
 * sub-protocol, while interactive mode renders the built-in selector.
 */
export async function showStartChoice(ctx: ExtensionCommandContext): Promise<StartChoice> {
  const options = START_CHOICES.map((choice) => choice.label);
  const choice = await ctx.ui.select(
    "Midcompact start — freeze the current context as an anchor; review, then commit or abort explicitly",
    options,
    ctx.mode === "rpc" ? { timeout: START_DIALOG_TIMEOUT_MS } : undefined,
  );
  if (choice === undefined) return "cancelled";
  return START_CHOICES[options.indexOf(choice)]?.value ?? "cancelled";
}