import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { buildAtoms, formatLocatedAtom, isProtectedAtom, locateAtomMatches } from "./atoms.js";
import { buildInventory, formatInventory, formatSpanInspection } from "./inventory.js";
import { messageText } from "./messages.js";
import { addDraftRange, emptyDraft, formatDraft, formatPlanMutation, removeDraftRange, replaceDraftRanges, updateDraftRange } from "./plan.js";
import { expandSelection } from "./selection.js";
import { projectMessages } from "./projection.js";
import { registerStateRenderer, stateTreeLabel } from "./renderers.js";
import { showReviewUi } from "./review-ui.js";
import { showSelectionUi } from "./selection-ui.js";
import { showStartChoice } from "./start-ui.js";
import { showReviewWebUi } from "./review-webui.js";

/**
 * Browser opener for the web workbenches. Tests override it to keep the suites
 * from spawning a system browser; production leaves it undefined and opens the
 * default browser.
 */
export let openReviewWebBrowser: ((url: string) => void) | undefined;

/** Test seam setter; see `openReviewWebBrowser`. */
export function setOpenReviewWebBrowser(opener?: (url: string) => void): void {
  openReviewWebBrowser = opener;
}
import {
  DRAFT_ENTRY,
  STATE_ENTRY,
  TXN_ENTRY,
  coerceDraftRange,
  defaultStartMode,
  emptyCompressionState,
  restoreCompressionState,
  restoreTransaction,
} from "./state.js";
import { draftTelemetry, formatPercent, formatTelemetry, formatTokenCount, snapshotContextUsage } from "./telemetry.js";
import type {
  Atom,
  CommitStats,
  CompressionBlock,
  CompressionState,
  DraftPlan,
  DraftTelemetry,
  MessageLike,
  SelectionSpan,
  StartMode,
  TransactionState,
} from "./types.js";
import {
  acquireAgent,
  emptyPlanningLock,
  releaseAgent,
  releaseUi,
  tryAcquireUi,
  type PlanningLockState,
} from "./planning-lock.js";

const TOOL_NAME = "midcompact";
const TOOL_DESCRIPTION =
  "Inventory, locate, draft, or recall mid-context compression. Use the `midcompact` skill to route planning versus recall; during an active transaction, follow the runtime prompt for the state-specific first action.";
const STATUS_KEY = "midcompact";
const START_PROMPT_PREFIX = "A mid-compaction transaction is active on a frozen anchor snapshot.";

const Params = Type.Object({
  action: StringEnum(["inspect", "locate", "plan", "recall"] as const),
  ref: Type.Optional(Type.String()),
  pattern: Type.Optional(Type.String()),
  source: Type.Optional(StringEnum(["any", "user", "assistant", "tool_call", "tool_result"] as const)),
  tool_name: Type.Optional(Type.String()),
  direction: Type.Optional(StringEnum(["oldest", "newest"] as const)),
  limit: Type.Optional(Type.Number()),
  detail: Type.Optional(StringEnum(["brief", "full"] as const)),
  op: Type.Optional(StringEnum(["show", "add", "update", "remove"] as const)),
  start: Type.Optional(Type.String()),
  end: Type.Optional(Type.String()),
  draft_id: Type.Optional(Type.String()),
  topic: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  // inspect inventory pagination or explicit candidate-span measurement
  page_size: Type.Optional(Type.Number()),
  cursor: Type.Optional(Type.String()),
  spans: Type.Optional(Type.Array(Type.Object({ start: Type.String(), end: Type.String() }))),
});

type ParamsType = Static<typeof Params>;

type RuntimeSnapshot = { atoms: Atom[]; anchorState?: CompressionState };

export default function (pi: ExtensionAPI) {
  let activeState: CompressionState | undefined;
  let transaction: TransactionState | undefined;
  let draft: DraftPlan | undefined;
  // Runtime mutex over DraftPlan edits. Not persisted: lost on reload by design.
  const planningLock: PlanningLockState = emptyPlanningLock();

  registerStateRenderer(pi);

  function restoreRuntime(ctx: ExtensionContext): void {
    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    activeState = restoreCompressionState(branch) ?? undefined;
    const restored = restoreTransaction(branch);
    if (restored.transaction) {
      const tx = withCompatDefaults(restored.transaction)!;
      transaction = tx;
      draft = restored.draft ? { ...restored.draft, ranges: restored.draft.ranges.map(coerceDraftRange) } : emptyDraft(tx.id);
    } else {
      transaction = undefined;
      draft = undefined;
    }
    planningLock.owner = undefined;
    updateStatus(ctx, transaction, draft, planningLock.owner);
  }

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => restoreRuntime(ctx));
  pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => restoreRuntime(ctx));
  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    activeState = undefined;
    transaction = undefined;
    draft = undefined;
    planningLock.owner = undefined;
  });

  // Agent turns hold the runtime edit lock for their entire lifetime, including
  // inspect/locate before the first DraftPlan mutation.
  pi.on("agent_start", async () => {
    if (transaction) acquireAgent(planningLock);
  });

  // Keep a user-created DraftPlan visible to the next Agent turn without
  // starting a turn automatically after the user saves the UI.
  pi.on("before_agent_start", async (event) => {
    if (!transaction || event.prompt.startsWith(START_PROMPT_PREFIX)) return;
    const currentDraft = draft ?? emptyDraft(transaction.id);
    return {
      message: {
        customType: "midcompact-handoff",
        content: [
          "An active midcompact transaction exists with a persisted DraftPlan.",
          `Draft revision ${currentDraft.revision}; ${currentDraft.ranges.length} existing range(s), which may have been created by the user.`,
          "If the current user request asks to continue midcompact, read the `midcompact` skill first, then call midcompact(action=\"plan\", op=\"show\") before any other midcompact action. Treat the existing plan as the current shared draft. Infer from the user's request whether to preserve, refine, or extend it; ask only if materially ambiguous.",
        ].join("\n"),
        display: false,
      },
    };
  });

  // Agent turn end releases the Agent's runtime edit lock so the user can open a UI.
  pi.on("agent_settled", async () => {
    releaseAgent(planningLock);
  });

  // Expose the UI-side lock operations so the future Selection/Review UI (and tests)
  // can acquire/release the runtime mutex without a dedicated tool action. This is
  // the UI's entry point for mutual exclusion, parallel to the Agent's plan mutation path.
  (pi as unknown as { midcompactPlanningLock?: unknown }).midcompactPlanningLock = {
    tryAcquireUi: () => tryAcquireUi(planningLock),
    releaseUi: () => releaseUi(planningLock),
    getOwner: () => planningLock.owner,
  };

  pi.on("context", async (event) => {
    if (!activeState?.blocks.length) return;
    return { messages: projectMessages(event.messages as MessageLike[], activeState) as typeof event.messages };
  });

  pi.registerCommand("midcompact", {
    description: "Start, select, review, commit, inspect, or abort a branch-isolated mid-context compression transaction",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const query = prefix.trimStart().toLowerCase();
      if (/\s/.test(query)) return null;
      const items: AutocompleteItem[] = [
        { value: "start", label: "start — Start a new midcompact transaction at the current anchor" },
        { value: "abort", label: "abort — Abort the active transaction and return to anchor" },
        { value: "commit", label: "commit — Commit the current draft to the branch state" },
        { value: "review", label: "review — Open interactive TUI to inspect and edit the draft" },
        { value: "review-webui", label: "review-webui — Open a local web page to inspect and edit the draft (works without TUI)" },
        { value: "select", label: "select — Open the TUI Selection surface to edit range boundaries" },
        { value: "select-webui", label: "select-webui — Open Selection in a local browser" },
        { value: "status", label: "status — Show current transaction and draft status" },
      ];
      const filtered = items.filter((item) => item.value.startsWith(query));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      const rawArgs = args.trim();
      const lower = rawArgs.toLowerCase();

      if (lower === "abort") return abortTransaction(ctx);
      if (lower === "commit") return commitTransaction(ctx);
      if (lower === "review") return reviewTransaction(ctx, "tui");
      if (lower === "review-webui") return reviewTransaction(ctx, "web");
      if (lower === "select") return openSelectionUi(ctx, "auto");
      if (lower === "select-webui") return openSelectionUi(ctx, "web");
      if (lower === "status") return showStatus(ctx);

      // start [instructions...]
      const startMatch = rawArgs.match(/^start\b\s*(.*)$/i);
      if (startMatch) {
        const instructions = (startMatch[1] ?? "").trim();
        return startTransaction(ctx, instructions || undefined);
      }

      ctx.ui.notify(
        "Usage: /midcompact start [instructions] | /midcompact select[-webui] | /midcompact review[-webui] | /midcompact commit | /midcompact status | /midcompact abort",
        "warning",
      );
    },
  });

  // ---- Transaction lifecycle ----

  async function startTransaction(ctx: ExtensionCommandContext, customInstructions?: string): Promise<void> {
    if (transaction) {
      ctx.ui.notify("A midcompact transaction is already active on this branch.", "warning");
      return;
    }
    const sm = ctx.sessionManager;
    const anchorEntryId = sm.getLeafId();
    if (!anchorEntryId) {
      ctx.ui.notify("Cannot start midcompact without a session leaf.", "error");
      return;
    }
    // Mode choice: Agent-first or User-first. Both operate on the same DraftPlan;
    // neither freezes boundaries. Drop maps to cancellation, so this one chooser
    // replaces the separate confirmation. No mode flags on the command line.
    const modeChoice = await chooseStartMode(ctx);
    if (modeChoice === "cancelled") {
      ctx.ui.notify("Midcompact start cancelled.", "info");
      return;
    }
    const startMode: StartMode = modeChoice;
    transaction = {
      version: 1,
      id: `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      anchorEntryId,
      startedAt: new Date().toISOString(),
      startMode,
      anchorUsage: snapshotContextUsage(ctx.getContextUsage()),
    };
    draft = emptyDraft(transaction.id);
    pi.appendEntry(TXN_ENTRY, transaction);
    pi.appendEntry(DRAFT_ENTRY, draft);
    updateStatus(ctx, transaction, draft, planningLock.owner);
    ctx.ui.notify(`Midcompact started at anchor ${anchorEntryId} (${startMode}-first). ${compactUsage(transaction)}`, "info");

    if (startMode === "agent") {
      await sendAgentStartPrompt(transaction, customInstructions, "agent");
      return;
    }
    // Use the same context setup for User manual, but make this turn an
    // acknowledgement only before opening the user editing surface.
    await sendAgentStartPrompt(transaction, customInstructions, "user");
    await ctx.waitForIdle();
    await openSelectionUi(ctx);
  }

  async function chooseStartMode(ctx: ExtensionCommandContext): Promise<StartMode | "cancelled"> {
    // The standard `select` dialog works identically in TUI and RPC; modes
    // without any UI (json/print) cannot prompt and default to Agent-first.
    if (!ctx.hasUI) return "agent";
    return showStartChoice(ctx);
  }

  async function openSelectionUi(ctx: ExtensionCommandContext, mode: "auto" | "tui" | "web" = "auto"): Promise<void> {
    const currentTx = transaction;
    if (!currentTx || !draft) {
      ctx.ui.notify("No active midcompact transaction.", "warning");
      return;
    }
    if (!tryAcquireUi(planningLock)) {
      ctx.ui.notify("The Agent is currently processing the midcompact draft. Try Selection after the Agent turn ends.", "warning");
      return;
    }

    const snapshot = buildAnchorSnapshot(ctx.sessionManager, currentTx);
    const applySelection = (spans: SelectionSpan[], keepRefs: string[]): void => {
      const normalized = expandSelection(snapshot.atoms, { spans, keepRefs });
      draft = replaceDraftRanges(draft ?? emptyDraft(currentTx.id), snapshot.atoms, normalized.spans);
      pi.appendEntry(DRAFT_ENTRY, draft);
      updateStatus(ctx, currentTx, draft, planningLock.owner);
    };

    try {
      if (mode === "tui" || (mode === "auto" && ctx.mode === "tui")) {
        const action = await showSelectionUi(ctx, snapshot.atoms, draft, draftTelemetry(currentTx, draft));
        if (action.action === "save") {
          try {
            applySelection(action.spans ?? [], action.keepRefs ?? []);
            ctx.ui.notify("DraftPlan saved. Tell the Agent to continue processing it when ready.", "info");
          } catch (error) {
            ctx.ui.notify(`Selection could not be saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
          }
        } else {
          ctx.ui.notify("Selection closed. The DraftPlan remains available; reopen select or tell the Agent to continue.", "info");
        }
        return;
      }
      await showReviewWebUi(ctx, snapshot.atoms, () => ({
        draft: draft ?? emptyDraft(currentTx.id),
        telemetry: draftTelemetry(currentTx, draft),
      }), {
        applySelection,
        editSummary: () => { throw new Error("Summary editing belongs to Review."); },
        editTopic: () => { throw new Error("Topic editing belongs to Review."); },
        remove: (id) => {
          draft = removeDraftRange(draft ?? emptyDraft(currentTx.id), id);
          pi.appendEntry(DRAFT_ENTRY, draft);
          updateStatus(ctx, currentTx, draft, planningLock.owner);
        },
      }, "selection", { openBrowser: openReviewWebBrowser });
      ctx.ui.notify("Selection closed. The DraftPlan is saved; tell the Agent to continue when ready.", "info");
    } finally {
      releaseUi(planningLock);
    }
  }

  async function sendAgentStartPrompt(tx: TransactionState, customInstructions: string | undefined, mode: StartMode): Promise<void> {
    const awareness = formatTelemetry(draftTelemetry(tx, draft));
    const promptLines = [
      START_PROMPT_PREFIX,
      awareness,
      "The extension provides inspect for bounded inventory, locate for local details, plan show/add/update/remove for one shared DraftPlan, and recall for committed blocks.",
      "The user owns the final compression decision. You may edit the DraftPlan, but you must not commit. Preserve facts that future work still needs; local character and image counts are not token estimates.",
    ];
    if (customInstructions) promptLines.push(`User focus: ${customInstructions}`);
    if (mode === "agent") {
      promptLines.push(
        "FINAL STATE: AGENT DIRECT. The new DraftPlan is empty. Read the `midcompact` skill before doing any planning work, then call inspect first and use locate and plan to create ranges and summaries. Stop before commit.",
      );
    } else {
      promptLines.push(
        "FINAL STATE: USER MANUAL. The user is about to edit the initial DraftPlan. Acknowledge with OK only. Do not call any midcompact tool, inspect, locate, plan, or recall; do not change the draft or commit. Wait until the user finishes editing and sends a later request. On that later request, read the `midcompact` skill before doing any planning work, then call plan show first.",
      );
    }
    await pi.sendUserMessage(promptLines.join("\n"));
  }

  async function abortTransaction(ctx: ExtensionCommandContext): Promise<void> {
    if (planningLock.owner === "agent") {
      ctx.ui.notify("The Agent is currently processing the midcompact draft. Abort after the Agent turn ends.", "warning");
      return;
    }
    const restored = restoreTransaction(ctx.sessionManager.getBranch() as SessionEntry[]);
    const currentTx = restored.transaction ?? transaction;
    if (!currentTx) {
      ctx.ui.notify("No active midcompact transaction.", "info");
      return;
    }
    const result = await ctx.navigateTree(currentTx.anchorEntryId, { summarize: false });
    if (result.cancelled) {
      ctx.ui.notify("Midcompact abort cancelled by tree navigation.", "warning");
      return;
    }
    transaction = undefined;
    draft = undefined;
    releaseAgent(planningLock);
    releaseUi(planningLock);
    updateStatus(ctx, transaction, draft, planningLock.owner);
    ctx.ui.notify("Midcompact transaction aborted; returned to anchor.", "info");
  }

  async function commitTransaction(ctx: ExtensionCommandContext): Promise<void> {
    if (planningLock.owner === "agent") {
      ctx.ui.notify("The Agent is currently processing the midcompact draft. Commit after the Agent turn ends.", "warning");
      return;
    }
    const restored = restoreTransaction(ctx.sessionManager.getBranch() as SessionEntry[]);
    const currentTx = withCompatDefaults(restored.transaction ?? transaction);
    const currentDraft = restored.draft?.ranges.map(coerceDraftRange) ? { ...restored.draft!, ranges: restored.draft.ranges.map(coerceDraftRange) } : draft;
    if (!currentTx) {
      ctx.ui.notify("No active midcompact transaction.", "warning");
      return;
    }
    if (!currentDraft?.ranges.length) {
      ctx.ui.notify("Draft is empty; nothing to commit.", "warning");
      return;
    }
    // Commit validation: reject empty summary, invalid boundaries, overlaps, protected atoms.
    const snapshot = buildAnchorSnapshot(ctx.sessionManager, currentTx);
    try {
      validateDraftForCommit(currentDraft, snapshot.atoms);
    } catch (err) {
      ctx.ui.notify(`Midcompact commit rejected: ${err instanceof Error ? err.message : String(err)}`, "warning");
      return;
    }
    const telemetry = draftTelemetry(currentTx, currentDraft);
    const nextState = mergeDraftIntoState(snapshot.anchorState, currentDraft, currentTx, telemetry);
    const result = await ctx.navigateTree(currentTx.anchorEntryId, { summarize: false });
    if (result.cancelled) {
      ctx.ui.notify("Midcompact commit cancelled by tree navigation.", "warning");
      return;
    }
    pi.appendEntry(STATE_ENTRY, nextState);
    const stateEntryId = ctx.sessionManager.getLeafId();
    if (stateEntryId) pi.setLabel(stateEntryId, stateTreeLabel(nextState));
    activeState = nextState;
    transaction = undefined;
    draft = undefined;
    releaseAgent(planningLock);
    releaseUi(planningLock);
    updateStatus(ctx, transaction, draft, planningLock.owner);
    ctx.ui.notify(commitNotice(nextState), "info");
  }

  async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
    const restored = restoreTransaction(ctx.sessionManager.getBranch() as SessionEntry[]);
    const currentTx = withCompatDefaults(restored.transaction ?? transaction);
    const currentDraft = restored.draft ?? draft;
    if (currentTx) {
      const parts = [
        formatDraft(currentDraft ?? emptyDraft(currentTx.id), draftTelemetry(currentTx, currentDraft)),
        `Mode: ${currentTx.startMode ?? "agent"}-first · lock: ${planningLock.owner ?? "free"}`,
      ];
      ctx.ui.notify(parts.join("\n"), "info");
      return;
    }
    if (!activeState?.blocks.length) {
      ctx.ui.notify("No active transaction and no active midcompact blocks on this branch.", "info");
      return;
    }
    ctx.ui.notify(activeStateStatus(activeState), "info");
  }

  async function reviewTransaction(ctx: ExtensionCommandContext, mode: "tui" | "web" = "tui"): Promise<void> {
    const restored = restoreTransaction(ctx.sessionManager.getBranch() as SessionEntry[]);
    const currentTx = withCompatDefaults(restored.transaction ?? transaction);
    const currentDraft = restored.draft ?? draft;
    if (!currentTx) {
      ctx.ui.notify("No active midcompact transaction.", "warning");
      return;
    }
    if (!tryAcquireUi(planningLock)) {
      ctx.ui.notify("The Agent is currently processing the midcompact draft. Try opening review after the Agent turn ends.", "warning");
      return;
    }
    try {
      const currentPlan = currentDraft ?? emptyDraft(currentTx.id);
      const snapshot = buildAnchorSnapshot(ctx.sessionManager, currentTx);

      const commitMutation = (next: DraftPlan): void => {
        draft = next;
        pi.appendEntry(DRAFT_ENTRY, next);
        updateStatus(ctx, currentTx, next, planningLock.owner);
      };

    if (mode === "web") {
      const getLatest = (): { draft: DraftPlan; telemetry: DraftTelemetry } => ({
        draft: draft ?? emptyDraft(currentTx.id),
        telemetry: draftTelemetry(currentTx, draft),
      });
      await showReviewWebUi(ctx, snapshot.atoms, getLatest, {
        editSummary: (id, summary) => commitMutation(updateDraftRange(draft ?? emptyDraft(currentTx.id), id, { summary })),
        editTopic: (id, topic) => commitMutation(updateDraftRange(draft ?? emptyDraft(currentTx.id), id, { topic: topic || undefined })),
        remove: (id) => commitMutation(removeDraftRange(draft ?? emptyDraft(currentTx.id), id)),
      }, undefined, { openBrowser: openReviewWebBrowser });
      ctx.ui.notify("Midcompact review-webui closed.", "info");
      return;
    }

    if (ctx.mode !== "tui") {
      ctx.ui.notify(
        "Interactive TUI review is only available in interactive (tui) mode. Use /midcompact review-webui to open a local web page instead.",
        "warning",
      );
      return;
    }

    while (true) {
      const plan = draft ?? emptyDraft(currentTx.id);
      const telemetry = draftTelemetry(currentTx, plan);
      const action = await showReviewUi(ctx, snapshot.atoms, plan, telemetry);
      if (action.action === "close") return;
      const range = plan.ranges.find((candidate) => candidate.id === action.draftId);
      if (!range) continue;

      if (action.action === "edit-summary") {
        const value = await ctx.ui.editor(`Edit ${range.id} summary`, range.summary);
        if (value === undefined || !value.trim()) continue;
        commitMutation(updateDraftRange(plan, range.id, { summary: value.trim() }));
        continue;
      }
      if (action.action === "edit-topic") {
        const value = await ctx.ui.input(`Edit ${range.id} topic`, range.topic ?? "");
        if (value === undefined) continue;
        commitMutation(updateDraftRange(plan, range.id, { topic: value.trim() || undefined }));
        continue;
      }
      if (action.action === "remove") {
        const approved = await ctx.ui.confirm("Remove compression range?", `${range.id}: ${range.startRef} → ${range.endRef}`);
        if (!approved) continue;
        commitMutation(removeDraftRange(plan, range.id));
      }
    }
    } finally {
      releaseUi(planningLock);
    }
  }

  // ---- Planning lock (runtime mutex, not persisted) ----

  /** Agent tool path: all active-transaction operations yield to an editing UI. */
  function requireAgentAccess(ctx: ExtensionContext): boolean {
    if (!acquireAgent(planningLock)) {
      ctx.ui.notify("A Selection/Review UI is currently editing the midcompact draft. Close it before the Agent can continue.", "warning");
      return false;
    }
    return true;
  }

  // UI-side acquire/release are exposed via the module re-export above so the
  // future Selection/Review UI (and tests) can drive them without going through
  // a tool action. The Agent acquires the lock at agent_start and releases it
  // at agent_settled.

  // ---- Tool ----

  pi.registerTool({
    name: TOOL_NAME,
    label: "Midcompact",
    description: TOOL_DESCRIPTION,
    parameters: Params,
    async execute(_id: string, params: ParamsType, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      try {
        if (params.action === "recall") return toolResult(handleRecall(params, ctx));
        const restored = restoreTransaction(ctx.sessionManager.getBranch() as SessionEntry[]);
        const currentTx = withCompatDefaults(restored.transaction ?? transaction);
        if (!currentTx) return toolResult("No active midcompact transaction. Ask the user to run `/midcompact start` first.");
        transaction = currentTx;
        draft = restored.draft ? { ...restored.draft, ranges: restored.draft.ranges.map(coerceDraftRange) } : (draft ?? emptyDraft(currentTx.id));
        if (!requireAgentAccess(ctx)) {
          return toolResult("Agent operation blocked: a user editing UI holds the planning lock.");
        }
        const snapshot = buildAnchorSnapshot(ctx.sessionManager, currentTx);

        if (params.action === "inspect") return toolResult(handleInspect(params, snapshot.atoms, currentTx));
        if (params.action === "locate") return toolResult(handleLocate(params, snapshot.atoms));
        if (params.action === "plan") {
          const result = handlePlan(params, draft!, snapshot.atoms);
          if (result.op === "show") {
            return toolResult(formatDraft(draft!, draftTelemetry(transaction, draft), {
              detail: params.detail,
              draftId: params.draft_id,
              atoms: snapshot.atoms,
            }));
          }
          draft = result.draft;
          pi.appendEntry(DRAFT_ENTRY, draft);
          updateStatus(ctx, transaction, draft, planningLock.owner);
          return toolResult(formatPlanMutation(draft, result.op, result.changedId, snapshot.atoms));
        }
        return toolResult("Unknown action.");
      } catch (error) {
        return toolResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  function handleInspect(params: ParamsType, atoms: Atom[], tx: TransactionState): string {
    if (params.spans) {
      if (params.page_size !== undefined || params.cursor !== undefined) {
        throw new Error("inspect spans cannot be combined with inventory pagination.");
      }
      return formatSpanInspection(atoms, params.spans);
    }
    const page = buildInventory(atoms, { pageSize: params.page_size, cursor: params.cursor }, { transaction: tx });
    return formatInventory(page);
  }

  function handleRecall(params: ParamsType, ctx: ExtensionContext): string {
    const sm = ctx.sessionManager;
    const branchState = restoreCompressionState(sm.getBranch() as SessionEntry[]) ?? activeState;
    if (!branchState?.blocks.length) return "No compressed blocks are active on this branch.";
    if (!params.ref) {
      const query = (params.pattern ?? "").trim().toLocaleLowerCase();
      const matches = branchState.blocks.filter((block) => !query || `${block.id}\n${block.topic ?? ""}\n${block.summary}`.toLocaleLowerCase().includes(query));
      if (!matches.length) return "No compressed blocks matched.";
      return matches.slice(0, Math.max(1, Math.min(params.limit ?? 8, 20))).map((block) =>
        `${block.id}${block.topic ? ` | ${block.topic}` : ""} | ${block.originalContentChars ?? 0} original chars${block.originalImageCount ? ` · ${block.originalImageCount} images` : ""}\n${block.summary}`
      ).join("\n\n");
    }
    const block = branchState.blocks.find((candidate) => candidate.id === params.ref);
    if (!block) return `Unknown compressed block ${params.ref}.`;
    const byId = new Map((sm.getEntries() as SessionEntry[]).map((entry) => [entry.id, entry]));
    const parts: string[] = [];
    for (const id of block.entryIds) {
      const entry = byId.get(id);
      if (entry?.type === "message") parts.push(`[${id}] ${messageText(entry.message as MessageLike)}`);
    }
    const full = parts.join("\n\n");
    const limit = params.detail === "full" ? 40_000 : 12_000;
    return full.length > limit ? `${full.slice(0, limit)}\n\n[truncated; refine the recall request or inspect the source session for more]` : full;
  }

  function withCompatDefaults(tx: TransactionState | undefined): TransactionState | undefined {
    if (!tx) return undefined;
    return {
      ...tx,
      startMode: defaultStartMode(tx.startMode),
    };
  }
}

// ---- Pure handlers ----

function handleLocate(params: ParamsType, atoms: Atom[]): string {
  const hasFilter = Boolean(params.pattern || params.tool_name || (params.source && params.source !== "any"));
  if (params.ref && hasFilter) {
    throw new Error("locate accepts either one direct ref or search filters, not both.");
  }
  if (params.detail === "full" && !params.ref) {
    throw new Error("locate detail=full requires one direct atom ref.");
  }
  const result = locateAtomMatches(atoms, {
    ref: params.ref,
    pattern: params.pattern,
    source: params.source,
    toolName: params.tool_name,
    direction: params.direction,
    limit: params.limit,
    detail: params.detail,
  });
  if (!result.atoms.length) return "No matching atoms in the frozen anchor snapshot.";
  const rendered = result.atoms
    .map((atom) => formatLocatedAtom(atom, params.detail ?? "brief", params.pattern))
    .join("\n\n---\n\n");
  if (result.totalMatches <= result.atoms.length) return rendered;
  return [
    `Showing ${result.atoms.length} of ${result.totalMatches} matches (${params.direction ?? "oldest"} first). Refine pattern or add source, tool_name, or direction.`,
    rendered,
  ].join("\n\n");
}

type PlanHandleResult =
  | { op: "show"; draft: DraftPlan }
  | { op: "add" | "update" | "remove"; draft: DraftPlan; changedId: string };

function handlePlan(params: ParamsType, current: DraftPlan, atoms: Atom[]): PlanHandleResult {
  const op = params.op ?? "show";
  if (op === "show") return { op, draft: current };
  if (op === "remove") {
    if (!params.draft_id) throw new Error("plan remove requires draft_id.");
    return { op, draft: removeDraftRange(current, params.draft_id), changedId: params.draft_id };
  }
  if (op === "update") {
    if (!params.draft_id) throw new Error("plan update requires draft_id.");
    if (params.summary === undefined && params.topic === undefined) throw new Error("plan update requires summary or topic.");
    return {
      op,
      draft: updateDraftRange(current, params.draft_id, { summary: params.summary, topic: params.topic }),
      changedId: params.draft_id,
    };
  }
  if (!params.start || !params.end) throw new Error("plan add requires start and end.");
  const next = addDraftRange(current, atoms, { start: params.start, end: params.end, summary: params.summary, topic: params.topic });
  const previousIds = new Set(current.ranges.map((range) => range.id));
  const changedId = next.ranges.find((range) => !previousIds.has(range.id))!.id;
  return { op, draft: next, changedId };
}

function validateDraftForCommit(draft: DraftPlan, atoms: Atom[]): void {
  for (const range of draft.ranges) {
    if (range.summary.trim().length === 0) {
      throw new Error(`Range ${range.id} has an empty (pending) summary; commit rejected.`);
    }
    if (range.startIndex > range.endIndex) throw new Error(`Range ${range.id} has reversed boundaries.`);
    const slice = atoms.slice(range.startIndex, range.endIndex + 1);
    const unsafe = slice.find((atom) => isProtectedAtom(atom));
    if (unsafe) throw new Error(`Range ${range.id} crosses protected atom ${unsafe.ref}.`);
  }
  for (let i = 1; i < draft.ranges.length; i += 1) {
    if (draft.ranges[i]!.startIndex <= draft.ranges[i - 1]!.endIndex) {
      throw new Error(`Ranges ${draft.ranges[i - 1]!.id} and ${draft.ranges[i]!.id} overlap.`);
    }
  }
}

function buildAnchorSnapshot(sm: ExtensionContext["sessionManager"], tx: TransactionState): RuntimeSnapshot {
  const entries = sm.getEntries() as SessionEntry[];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const built = buildSessionContext(entries, tx.anchorEntryId, byId);
  const anchorBranch = sm.getBranch(tx.anchorEntryId) as SessionEntry[];
  const anchorState = restoreCompressionState(anchorBranch);
  const visibleMessages = projectMessages(built.messages as MessageLike[], anchorState);
  return { atoms: buildAtoms(visibleMessages, anchorBranch as any), anchorState };
}

function mergeDraftIntoState(
  base: CompressionState | undefined,
  draft: DraftPlan,
  transaction: TransactionState,
  telemetry: ReturnType<typeof draftTelemetry>,
): CompressionState {
  const previous = base ?? emptyCompressionState();
  const blocks = [...previous.blocks];
  const addedBlockIds: string[] = [];
  let next = nextBlockNumber(blocks);
  for (const range of draft.ranges) {
    const block: CompressionBlock = {
      id: `c${String(next).padStart(4, "0")}`,
      topic: range.topic,
      summary: range.summary,
      entryIds: [...range.entryIds],
      messageKeys: [...range.messageKeys],
      createdAt: new Date().toISOString(),
      originalContentChars: range.originalContentChars,
      originalImageCount: range.originalImageCount,
      originalImagePayloadBytes: range.originalImagePayloadBytes,
      replacementContentChars: range.replacementContentChars,
      originalApproxTokens: range.originalApproxTokens,
      compressedApproxTokens: range.compressedApproxTokens,
    };
    blocks.push(block);
    addedBlockIds.push(block.id);
    next += 1;
  }
  const committedAt = new Date().toISOString();
  const lastCommit: CommitStats = {
    transactionId: transaction.id,
    committedAt,
    addedBlockIds,
    addedRangeCount: draft.ranges.length,
    selectedOriginalContentChars: telemetry.selectedOriginalContentChars,
    selectedReplacementContentChars: telemetry.selectedReplacementContentChars,
    selectedImageCount: telemetry.selectedImageCount,
    selectedImagePayloadBytes: telemetry.selectedImagePayloadBytes,
    anchorUsage: transaction.anchorUsage,
    selectedOriginalApproxTokens: telemetry.selectedOriginalApproxTokens,
    selectedCompressedApproxTokens: telemetry.selectedCompressedApproxTokens,
    estimatedSavedTokens: telemetry.estimatedSavedTokens,
    projectedTokens: telemetry.projectedTokens,
    projectedPercent: telemetry.projectedPercent,
  };
  return { version: 1, createdAt: committedAt, blocks, lastCommit };
}

function nextBlockNumber(blocks: CompressionBlock[]): number {
  let max = 0;
  for (const block of blocks) {
    const match = /^c(\d+)$/.exec(block.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function updateStatus(
  ctx: ExtensionContext,
  tx: TransactionState | undefined,
  currentDraft: DraftPlan | undefined,
  lockOwner: "agent" | "ui" | undefined = undefined,
): void {
  const theme = ctx.ui.theme;
  if (tx) {
    const pending = (currentDraft?.ranges ?? []).filter((range) => range.summary.trim().length === 0).length;
    const chars = (currentDraft?.ranges ?? []).reduce((sum, range) => sum + range.originalContentChars, 0);
    const lock = lockOwner === "ui" ? " · UI editing" : lockOwner === "agent" ? " · Agent editing" : "";
    ctx.ui.setStatus(
      STATUS_KEY,
      `${theme.fg("accent", "MC planning")} · ${currentDraft?.ranges.length ?? 0} ranges${pending ? ` · ${pending} pending` : ""} · ${chars} chars${lock}`,
    );
    return;
  }
  ctx.ui.setStatus(STATUS_KEY, undefined);
}

function compactUsage(tx: TransactionState): string {
  const usage = tx.anchorUsage;
  if (!usage) return "Anchor context usage unavailable [Pi reported].";
  return `Anchor context ${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)} (${formatPercent(usage.percent)}) [Pi reported].`;
}

function activeStateStatus(state: CompressionState): string {
  const originalChars = state.blocks.reduce((sum, block) => sum + (block.originalContentChars ?? 0), 0);
  const replacementChars = state.blocks.reduce((sum, block) => sum + (block.replacementContentChars ?? 0), 0);
  return `Midcompact active on this branch: ${state.blocks.length} block(s), ${originalChars} → ${replacementChars} content chars. Original history remains recallable.`;
}

function commitNotice(state: CompressionState): string {
  const commit = state.lastCommit;
  if (!commit) return `Midcompact committed: ${state.blocks.length} active compressed block(s).`;
  return `Midcompact committed: ${commit.addedRangeCount} new range(s), ${commit.selectedOriginalContentChars} → ${commit.selectedReplacementContentChars} content chars${commit.selectedImageCount ? ` · ${commit.selectedImageCount} images` : ""}. Original history retained; use recall for exact details.`;
}

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
