import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { StartMode } from "./types.js";

export type StartChoice = StartMode | "cancelled" | "unrecognized";

interface StartChoiceOption {
  value: StartChoice;
  label: string;
}

/**
 * The three entry decisions. Shared by TUI and RPC so every mode offers the
 * same choice set in the same order. Agent direct comes first: the standard
 * selector highlights the first option, so Enter on open keeps the fast
 * Agent-first start path, and RPC clients see the recommended entry first.
 */
const START_CHOICES: StartChoiceOption[] = [
  { value: "agent", label: "Agent direct — Inspect and draft with Agent" },
  { value: "user", label: "User manual — Select the initial DraftPlan yourself" },
  { value: "cancelled", label: "Drop — Leave the session unchanged" },
];

/**
 * Bound for RPC dialog waits. The timeout exists only as a safety net: when
 * the RPC client never answers, the extension-UI sub-protocol auto-resolves
 * the dialog (`undefined`) so the start cancels instead of blocking the
 * extension forever. 120s is generous for the human on the other side of the
 * wire (pi's own examples use 5s for urgent security confirms) while still
 * bounding the worst-case stall. TUI mode passes no timeout: interactive
 * users may take as long as they want.
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
  // A value outside the offered options is a protocol mismatch on the client
  // side, not a user decision; keep it distinguishable from a real Drop.
  const index = options.indexOf(choice);
  return index >= 0 ? START_CHOICES[index]!.value : "unrecognized";
}