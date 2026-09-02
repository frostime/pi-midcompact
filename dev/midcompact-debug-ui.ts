// Debug-only preview surface for the WebGUI workbench. Loaded via
// pi-invoke-this.ps1 (-e); the production extension (src/index.ts) never
// registers it and package.json's pi.extensions never references this file.
//
// Isolation contract:
//   - imports domain modules only; never imports ../src/index.ts, so the
//     transaction/lock/persistence machinery stays unreachable from here;
//   - reads the session through read-only accessors only (getBranch);
//   - every workbench write (save/remove/selection) mutates an in-memory
//     draft — nothing is ever appended to the session branch.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { buildAtoms } from "../src/atoms.js";
import { addDraftRange, emptyDraft, replaceDraftRanges } from "../src/plan.js";
import { expandSelection } from "../src/selection.js";
import { draftTelemetry } from "../src/telemetry.js";
import { showReviewWebUi } from "../src/review-webui.js";
import type { Atom, DraftPlan, MessageLike, SelectionSpan } from "../src/types.js";

// Synthetic "reported" usage so the projection bar has a baseline to draw.
// Preview fixture only: real numbers exist only in a real transaction.
const PREVIEW_TX = {
  version: 1 as const,
  id: "debug-preview",
  anchorEntryId: "",
  startedAt: "",
  anchorUsage: { tokens: 160_000, contextWindow: 200_000, percent: 80, capturedAt: "" },
};

type Memory = { draft: DraftPlan };

const VIEWS = [
  { value: "review", label: "review", description: "Inspect and edit the generated draft (default)" },
  { value: "selection", label: "selection", description: "Build ranges by selecting atoms in the timeline" },
];

export default function (pi: ExtensionAPI) {
  pi.registerCommand("midcompact:debug-ui", {
    description: "Preview the workbench with in-memory data (no session writes)",
    getArgumentCompletions: (prefix: string) =>
      VIEWS.filter((view) => view.value.startsWith(prefix.trim().toLowerCase())),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const arg = String(args ?? "").trim().toLowerCase();
      if (arg && arg !== "review" && arg !== "selection") {
        ctx.ui.notify(`debug-ui: unknown view "${arg}" — use review or selection.`, "warning");
        return;
      }
      const view = arg === "selection" ? "selection" : "review";
      const branch = ctx.sessionManager.getBranch() as SessionEntry[];
      const messageEntries = branch.filter((entry) => entry.type === "message" && entry.message);
      const atoms = buildAtoms(
        messageEntries.map((entry) => entry.message as MessageLike),
        messageEntries,
      );
      if (!atoms.length) {
        ctx.ui.notify("debug-ui: no message atoms in this session; nothing to preview.", "warning");
        return;
      }
      const memory: Memory = { draft: previewDraft(atoms, view) };
      const getLatest = () => ({ draft: memory.draft, telemetry: draftTelemetry(PREVIEW_TX, memory.draft) });
      await showReviewWebUi(ctx, atoms, getLatest, {
        applySelection: (spans: SelectionSpan[], keepRefs: string[]) => {
          const normalized = expandSelection(atoms, { spans, keepRefs });
          memory.draft = replaceDraftRanges(memory.draft, atoms, normalized.spans);
        },
        editSummary: (id: string, summary: string) => {
          const range = memory.draft.ranges.find((candidate) => candidate.id === id);
          if (range) { range.summary = summary; memory.draft.revision += 1; }
        },
        editTopic: (id: string, topic: string) => {
          const range = memory.draft.ranges.find((candidate) => candidate.id === id);
          if (range) { range.topic = topic; memory.draft.revision += 1; }
        },
        remove: (id: string) => {
          memory.draft = { ...memory.draft, ranges: memory.draft.ranges.filter((range) => range.id !== id) };
        },
      }, view);
      ctx.ui.notify("debug-ui preview closed — nothing was written to the session.", "info");
    },
  });
}

/** Seed a preview draft: in review view, up to two compressible runs — first summarized, second pending. */
function previewDraft(atoms: readonly Atom[], view: "review" | "selection"): DraftPlan {
  const draft = emptyDraft(PREVIEW_TX.id);
  if (view !== "review") return draft;
  const runs: Array<{ start: number; end: number }> = [];
  atoms.forEach((atom, index) => {
    if (!atom.compressible) return;
    const last = runs.at(-1);
    if (last && last.end + 1 === index) last.end = index;
    else runs.push({ start: index, end: index });
  });
  runs
    .filter((run) => run.end - run.start + 1 >= 3)
    .slice(0, 2)
    .forEach((run, index) => {
      try {
        const next = addDraftRange(draft, [...atoms], {
          start: atoms[run.start]!.ref,
          end: atoms[run.end]!.ref,
          topic: `preview ${index + 1}`,
          summary: index === 0 ? `Preview summary replacing ${atoms[run.start]!.ref}→${atoms[run.end]!.ref}.` : "",
        });
        draft.ranges = next.ranges;
        draft.revision = next.revision;
      } catch {
        // Overlap/protected edge in this session's data — skip that run.
      }
    });
  return draft;
}
