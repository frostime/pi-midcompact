import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { buildAtoms, formatLocatedAtom, isProtectedAtom, locateAtoms } from "./atoms.js";
import { buildInventory, formatInventory } from "./inventory.js";
import { messageText } from "./messages.js";
import { addDraftRange, addPendingRanges, emptyDraft, formatDraft, removeDraftRange, updateDraftRange } from "./plan.js";
import { projectMessages } from "./projection.js";
import { registerStateRenderer, stateTreeLabel } from "./renderers.js";
import { showReviewUi } from "./review-ui.js";
import { showReviewWebUi } from "./review-webui.js";
import { expandSelection, SelectionError } from "./selection.js";
import {
  DRAFT_ENTRY,
  SELECTION_ENTRY,
  STATE_ENTRY,
  TXN_ENTRY,
  coerceDraftRange,
  defaultTransactionMode,
  defaultTransactionPhase,
  emptyCompressionState,
  emptySelection,
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
  SelectionState,
  TransactionMode,
  TransactionState,
} from "./types.js";

const TOOL_NAME = "midcompact";
const TOOL_DESCRIPTION =
  "Inventory, locate, draft, or recall mid-context compression. Agent workflow: inspect first, then persist a candidate Selection, wait for explicit user confirmation, then locate/plan summaries. Use the `midcompact` skill for workflow guidance.";
const STATUS_KEY = "midcompact";

const Params = Type.Object({
  action: StringEnum(["inspect", "locate", "plan", "recall", "select", "confirm"] as const),
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
  // inspect pagination
  page_size: Type.Optional(Type.Number()),
  cursor: Type.Optional(Type.String()),
  // selection mutation: spans + keep refs as JSON-encoded arrays
  spans: Type.Optional(Type.String()),
  keep_refs: Type.Optional(Type.String()),
});

type ParamsType = Static<typeof Params>;

type RuntimeSnapshot = { atoms: Atom[]; anchorState?: CompressionState };

export default function (pi: ExtensionAPI) {
  let activeState: CompressionState | undefined;
  let transaction: TransactionState | undefined;
  let draft: DraftPlan | undefined;
  let selection: SelectionState | undefined;

  registerStateRenderer(pi);

  function restoreRuntime(ctx: ExtensionContext): void {
    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    activeState = restoreCompressionState(branch) ?? undefined;
    const restored = restoreTransaction(branch);
    if (restored.transaction) {
      const tx = withCompatDefaults(restored.transaction, restored.draft)!;
      transaction = tx;
      draft = restored.draft ? { ...restored.draft, ranges: restored.draft.ranges.map(coerceDraftRange) } : emptyDraft(tx.id);
      selection = restored.selection;
    } else {
      transaction = undefined;
      draft = undefined;
      selection = undefined;
    }
    updateStatus(ctx, transaction, draft);
  }

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => restoreRuntime(ctx));
  pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => restoreRuntime(ctx));
  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    activeState = undefined;
    transaction = undefined;
    draft = undefined;
    selection = undefined;
  });

  pi.on("context", async (event) => {
    if (!activeState?.blocks.length) return;
    return { messages: projectMessages(event.messages as MessageLike[], activeState) as typeof event.messages };
  });

  pi.registerCommand("midcompact", {
    description: "Start, review, commit, inspect, confirm, or abort a branch-isolated mid-context compression transaction",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const query = prefix.trimStart().toLowerCase();
      if (/\s/.test(query)) return null;
      const items: AutocompleteItem[] = [
        { value: "start", label: "start — Start a new midcompact transaction at the current anchor" },
        { value: "start --user", label: "start --user — Start in User select mode (manual range selection)" },
        { value: "start --agent", label: "start --agent — Start in Agent propose mode (Agent drafts the proposal)" },
        { value: "abort", label: "abort — Abort the active transaction and return to anchor" },
        { value: "commit", label: "commit — Commit the current draft to the branch state" },
        { value: "review", label: "review — Open interactive TUI to inspect and edit the draft" },
        { value: "review-webui", label: "review-webui — Open a local web page to inspect and edit the draft (works without TUI)" },
        { value: "confirm", label: "confirm — Confirm the current Selection and materialize pending ranges" },
        { value: "status", label: "status — Show current transaction, selection, and draft status" },
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
      if (lower === "confirm") return confirmSelection(ctx);
      if (lower === "status") return showStatus(ctx);

      // start [--user|--agent] [instructions...]
      const startMatch = rawArgs.match(/^start\b\s*(.*)$/i);
      if (startMatch) {
        const rest = startMatch[1] ?? "";
        const flagMatch = rest.match(/^(--user|--agent)\b\s*(.*)$/i);
        const mode: TransactionMode | undefined = flagMatch
          ? (flagMatch[1]!.toLowerCase() === "--user" ? "user" : "agent")
          : undefined;
        const instructions = (flagMatch ? flagMatch[2] : rest).trim();
        return startTransaction(ctx, mode, instructions || undefined);
      }

      ctx.ui.notify(
        "Usage: /midcompact start [--user|--agent] [instructions] | /midcompact confirm | /midcompact review | /midcompact commit | /midcompact status | /midcompact abort",
        "warning",
      );
    },
  });

  // ---- Transaction lifecycle ----

  async function startTransaction(ctx: ExtensionCommandContext, mode: TransactionMode | undefined, customInstructions?: string): Promise<void> {
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
    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm(
        "Start midcompact transaction?",
        "The current context snapshot will be frozen as an anchor. You will need to review and explicitly commit (/midcompact commit) or abort (/midcompact abort) later.",
      );
      if (!ok) {
        ctx.ui.notify("Midcompact start cancelled.", "info");
        return;
      }
    }
    // Freeze anchor FIRST: persist transaction + empty Selection + empty draft, then decide mode.
    const resolvedMode: TransactionMode = mode ?? "agent";
    transaction = {
      version: 1,
      id: `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      anchorEntryId,
      startedAt: new Date().toISOString(),
      mode: resolvedMode,
      phase: "selecting",
      anchorUsage: snapshotContextUsage(ctx.getContextUsage()),
    };
    draft = emptyDraft(transaction.id);
    selection = emptySelection(transaction.id, resolvedMode);
    pi.appendEntry(TXN_ENTRY, transaction);
    pi.appendEntry(SELECTION_ENTRY, selection);
    pi.appendEntry(DRAFT_ENTRY, draft);
    updateStatus(ctx, transaction, draft);
    ctx.ui.notify(`Midcompact started at anchor ${anchorEntryId} (${resolvedMode} mode). ${compactUsage(transaction)}`, "info");

    if (resolvedMode === "agent") {
      sendAgentStartPrompt(transaction, customInstructions);
      return;
    }
    // User select mode: do NOT trigger the model until Selection is confirmed.
    ctx.ui.notify(
      "User select mode: build your Selection via midcompact(action=\"select\") and run /midcompact confirm when ready. No Agent prompt until then.",
      "info",
    );
  }

  function sendAgentStartPrompt(tx: TransactionState, customInstructions?: string): void {
    const awareness = formatTelemetry(draftTelemetry(tx, draft));
    const promptLines = [
      "A mid-compaction transaction is active on a frozen anchor snapshot.",
      awareness,
      "These numbers are context awareness, not a target or optimization constraint. Use them to judge the scale of proposed compression while preserving semantic value.",
      "Workflow: first call midcompact(action=\"inspect\") to see the global distribution; then propose candidate ranges, persist them with midcompact(action=\"select\"), and wait for the user to run /midcompact confirm. Only after confirmation may you locate/plan and write summaries.",
      "Do NOT call midcompact(action=\"plan\", op=\"add\") before the user confirms the Selection.",
      "You cannot commit. The user reviews and explicitly runs /midcompact commit.",
    ];
    if (customInstructions) promptLines.push(`User focus: ${customInstructions}`);
    pi.sendUserMessage(promptLines.join("\n"));
  }

  async function confirmSelection(ctx: ExtensionCommandContext): Promise<void> {
    const restored = restoreTransaction(ctx.sessionManager.getBranch() as SessionEntry[]);
    const currentTx = withCompatDefaults(restored.transaction ?? transaction, restored.draft ?? draft);
    const currentSelection = restored.selection ?? selection;
    if (!currentTx) {
      ctx.ui.notify("No active midcompact transaction.", "warning");
      return;
    }
    if (!currentSelection || currentSelection.spans.length === 0) {
      ctx.ui.notify("No Selection to confirm. Build one with midcompact(action=\"select\") first.", "warning");
      return;
    }
    if (currentSelection.confirmed) {
      ctx.ui.notify("Selection is already confirmed; use /midcompact review or run summaries.", "info");
      return;
    }
    const snapshot = buildAnchorSnapshot(ctx.sessionManager, currentTx);
    let confirmed;
    try {
      confirmed = expandSelection(snapshot.atoms, { spans: currentSelection.spans, keepRefs: currentSelection.keepRefs });
    } catch (err) {
      ctx.ui.notify(`Cannot confirm Selection: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }
    if (confirmed.spans.length === 0) {
      ctx.ui.notify("Selection resolves to no compressible ranges (all protected or KEEP).", "warning");
      return;
    }
    // Materialize pending ranges and advance phase to summarizing.
    transaction = currentTx;
    draft = restored.draft ?? draft ?? emptyDraft(currentTx.id);
    draft = addPendingRanges(draft, snapshot.atoms, confirmed.spans);
    selection = {
      ...currentSelection,
      confirmed: true,
      materializedRangeRefs: confirmed.spans.map((span) => ({ startRef: span.startRef, endRef: span.endRef })),
      updatedAt: new Date().toISOString(),
    };
    transaction = { ...transaction, phase: "summarizing" };
    pi.appendEntry(SELECTION_ENTRY, selection);
    pi.appendEntry(TXN_ENTRY, transaction);
    pi.appendEntry(DRAFT_ENTRY, draft);
    updateStatus(ctx, transaction, draft);
    ctx.ui.notify(
      `Selection confirmed: ${confirmed.spans.length} pending range(s). Phase → summarizing. Agent will write summaries without moving your boundaries.`,
      "info",
    );
    if (transaction.mode === "user") {
      sendUserSelectSummaryPrompt(ctx.sessionManager, transaction, confirmed.spans);
    } else {
      sendAgentConfirmPrompt(transaction, confirmed.spans);
    }
  }

  function sendUserSelectSummaryPrompt(sm: ExtensionContext["sessionManager"], tx: TransactionState, spans: ReadonlyArray<{ startRef: string; endRef: string }>): void {
    const snapshot = buildAnchorSnapshot(sm, tx);
    const spanLines = spans.map((span) => {
      const startAtom = snapshot.atoms.find((atom) => atom.ref === span.startRef)!;
      const endAtom = snapshot.atoms.find((atom) => atom.ref === span.endRef)!;
      const slice = snapshot.atoms.slice(startAtom.index, endAtom.index + 1);
      const chars = slice.reduce((sum, atom) => sum + atom.metrics.contentChars, 0);
      const images = slice.reduce((sum, atom) => sum + atom.metrics.imageCount, 0);
      return `${span.startRef}→${span.endRef} | ${chars} chars${images ? ` · ${images} images` : ""}`;
    });
    pi.sendUserMessage([
      "User-confirmed selection is now materialized as pending ranges. Write a non-empty summary for each range; do not expand or move the confirmed boundaries.",
      ...spanLines,
      "Call midcompact(action=\"plan\", op=\"update\", draft_id=..., summary=...) for each range. The user will review and commit.",
    ].join("\n"));
  }

  function sendAgentConfirmPrompt(tx: TransactionState, spans: ReadonlyArray<{ startRef: string; endRef: string }>): void {
    pi.sendUserMessage([
      "The user confirmed the Selection. Pending ranges are materialized; you may now locate boundary atoms and write summaries for each range.",
      `Ranges: ${spans.map((span) => `${span.startRef}→${span.endRef}`).join(", ")}`,
      "Do not move confirmed boundaries. You cannot commit.",
    ].join("\n"));
  }

  async function abortTransaction(ctx: ExtensionCommandContext): Promise<void> {
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
    selection = undefined;
    updateStatus(ctx, transaction, draft);
    ctx.ui.notify("Midcompact transaction aborted; returned to anchor.", "info");
  }

  async function commitTransaction(ctx: ExtensionCommandContext): Promise<void> {
    const restored = restoreTransaction(ctx.sessionManager.getBranch() as SessionEntry[]);
    const currentTx = withCompatDefaults(restored.transaction ?? transaction, restored.draft ?? draft);
    const currentDraft = restored.draft?.ranges.map(coerceDraftRange) ? { ...restored.draft!, ranges: restored.draft.ranges.map(coerceDraftRange) } : draft;
    if (!currentTx) {
      ctx.ui.notify("No active midcompact transaction.", "warning");
      return;
    }
    if (!currentDraft?.ranges.length) {
      ctx.ui.notify("Draft is empty; nothing to commit.", "warning");
      return;
    }
    // Commit validation: reject pending summary, invalid boundaries, overlaps, protected atoms.
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
    selection = undefined;
    updateStatus(ctx, transaction, draft);
    ctx.ui.notify(commitNotice(nextState), "info");
  }

  async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
    const restored = restoreTransaction(ctx.sessionManager.getBranch() as SessionEntry[]);
    const currentTx = withCompatDefaults(restored.transaction ?? transaction, restored.draft ?? draft);
    const currentDraft = restored.draft ?? draft;
    const currentSelection = restored.selection ?? selection;
    if (currentTx) {
      const parts = [
        formatDraft(currentDraft ?? emptyDraft(currentTx.id), draftTelemetry(currentTx, currentDraft)),
      ];
      if (currentSelection) {
        parts.push(`Selection: ${currentSelection.confirmed ? "confirmed" : "unconfirmed"} · ${currentSelection.spans.length} span(s) · ${currentSelection.keepRefs.length} KEEP · mode ${currentSelection.mode} · phase ${currentTx.phase ?? "selecting"}`);
      }
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
    const currentTx = withCompatDefaults(restored.transaction ?? transaction, restored.draft ?? draft);
    const currentDraft = restored.draft ?? draft;
    if (!currentTx) {
      ctx.ui.notify("No active midcompact transaction.", "warning");
      return;
    }
    const currentPlan = currentDraft ?? emptyDraft(currentTx.id);
    const snapshot = buildAnchorSnapshot(ctx.sessionManager, currentTx);

    const commitMutation = (next: DraftPlan): void => {
      draft = next;
      pi.appendEntry(DRAFT_ENTRY, next);
      updateStatus(ctx, currentTx, next);
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
      });
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
  }

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
        const currentTx = withCompatDefaults(restored.transaction ?? transaction, restored.draft ?? draft);
        if (!currentTx) return toolResult("No active midcompact transaction. Ask the user to run `/midcompact start` first.");
        transaction = currentTx;
        selection = restored.selection ?? selection;
        draft = restored.draft ? { ...restored.draft, ranges: restored.draft.ranges.map(coerceDraftRange) } : (draft ?? emptyDraft(currentTx.id));
        const snapshot = buildAnchorSnapshot(ctx.sessionManager, currentTx);

        if (params.action === "inspect") return toolResult(handleInspect(params, snapshot.atoms, currentTx));
        if (params.action === "locate") return toolResult(handleLocate(params, snapshot.atoms));
        if (params.action === "select") return toolResult(handleSelect(params, snapshot.atoms, ctx));
        if (params.action === "confirm") {
          // Tool-level confirm is an explicit programmatic confirmation path for
          // Agent propose; runtime still enforces the same guard.
          return toolResult(handleToolConfirm(params, snapshot.atoms, ctx));
        }
        if (params.action === "plan") {
          guardPlanMutation(currentTx, params);
          draft = handlePlan(params, draft!, snapshot.atoms);
          pi.appendEntry(DRAFT_ENTRY, draft);
          updateStatus(ctx, transaction, draft);
          return toolResult(formatDraft(draft, draftTelemetry(transaction, draft)));
        }
        return toolResult("Unknown action.");
      } catch (error) {
        return toolResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  function handleInspect(params: ParamsType, atoms: Atom[], tx: TransactionState): string {
    const page = buildInventory(atoms, { pageSize: params.page_size, cursor: params.cursor }, { transaction: tx });
    return formatInventory(page);
  }

  function handleSelect(params: ParamsType, atoms: Atom[], _ctx: ExtensionContext): string {
    if (!selection) throw new Error("No active Selection; start a transaction first.");
    if (selection.confirmed) throw new Error("Selection is already confirmed; boundaries cannot be changed. Abort and restart to edit.");
    const spans = parseJsonArray("spans", params.spans, (item) => ({ startRef: item.startRef, endRef: item.endRef }));
    const keepRefs = parseJsonArray("keep_refs", params.keep_refs, (item) => item) as string[];
    // Validate against atoms so the caller gets a clear error before the Selection is persisted.
    const result = expandSelection(atoms, { spans, keepRefs });
    selection = { ...selection, spans, keepRefs, updatedAt: new Date().toISOString() };
    pi.appendEntry(SELECTION_ENTRY, selection);
    const preview = result.spans.length
      ? result.spans.map((span) => `${span.startRef}→${span.endRef}`).join(", ")
      : "(resolves to no compressible ranges yet)";
    return `Selection persisted (unconfirmed): ${spans.length} requested span(s), ${keepRefs.length} KEEP. Expanded ordinary spans: ${preview}. Run /midcompact confirm (or midcompact action=confirm) to materialize pending ranges.`;
  }

  function handleToolConfirm(_params: ParamsType, atoms: Atom[], _ctx: ExtensionContext): string {
    if (!selection) throw new Error("No active Selection to confirm.");
    if (selection.confirmed) return "Selection already confirmed.";
    if (selection.spans.length === 0) throw new Error("Selection is empty; add spans with action=select first.");
    const result = expandSelection(atoms, { spans: selection.spans, keepRefs: selection.keepRefs });
    if (result.spans.length === 0) throw new SelectionError("Selection resolves to no compressible ranges.");
    draft ??= emptyDraft(transaction!.id);
    draft = addPendingRanges(draft, atoms, result.spans);
    selection = {
      ...selection,
      confirmed: true,
      materializedRangeRefs: result.spans.map((span) => ({ startRef: span.startRef, endRef: span.endRef })),
      updatedAt: new Date().toISOString(),
    };
    transaction = { ...transaction!, phase: "summarizing" };
    pi.appendEntry(SELECTION_ENTRY, selection);
    pi.appendEntry(TXN_ENTRY, transaction);
    pi.appendEntry(DRAFT_ENTRY, draft);
    return `Selection confirmed: ${result.spans.length} pending range(s) materialized. Phase → summarizing.`;
  }

  function guardPlanMutation(tx: TransactionState, params: ParamsType): void {
    const op = params.op ?? "show";
    if (op === "show") return;
    // Runtime guard: the selecting phase has no confirmed Selection yet, so no plan mutation is allowed.
    const phase = tx.phase ?? defaultTransactionPhase(undefined, draft);
    if (phase === "selecting") {
      throw new Error("Transaction is in selecting phase; build and confirm a Selection before mutating the plan.");
    }
    if (op === "add") {
      // Adding ranges requires a confirmed Selection; summaries are then filled via op="update".
      if (!selection?.confirmed) {
        throw new Error("Plan add requires a confirmed Selection; confirm the Selection first (/midcompact confirm).");
      }
    }
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

  function withCompatDefaults(tx: TransactionState | undefined, restoredDraft?: DraftPlan): TransactionState | undefined {
    if (!tx) return undefined;
    return {
      ...tx,
      mode: defaultTransactionMode(tx.mode),
      phase: defaultTransactionPhase(tx.phase, restoredDraft),
    };
  }
}

// ---- Pure handlers ----

function handleLocate(params: ParamsType, atoms: Atom[]): string {
  const matches = locateAtoms(atoms, {
    ref: params.ref,
    pattern: params.pattern,
    source: params.source,
    toolName: params.tool_name,
    direction: params.direction,
    limit: params.limit,
    detail: params.detail,
  });
  if (!matches.length) return "No matching atoms in the frozen anchor snapshot.";
  return matches.map((atom) => formatLocatedAtom(atom, params.detail ?? "brief")).join("\n\n---\n\n");
}

function handlePlan(params: ParamsType, current: DraftPlan, atoms: Atom[]): DraftPlan {
  const op = params.op ?? "show";
  if (op === "show") return current;
  if (op === "remove") {
    if (!params.draft_id) throw new Error("plan remove requires draft_id.");
    return removeDraftRange(current, params.draft_id);
  }
  if (op === "update") {
    if (!params.draft_id) throw new Error("plan update requires draft_id.");
    if (params.summary === undefined && params.topic === undefined) throw new Error("plan update requires summary or topic.");
    return updateDraftRange(current, params.draft_id, { summary: params.summary, topic: params.topic });
  }
  if (!params.start || !params.end) throw new Error("plan add requires start and end.");
  return addDraftRange(current, atoms, { start: params.start, end: params.end, summary: params.summary, topic: params.topic });
}

function parseJsonArray<T>(field: string, raw: string | undefined, map: (item: any) => T): T[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`\`${field}\` must be a JSON-encoded array.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`\`${field}\` must be a JSON-encoded array.`);
  return parsed.map(map);
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
): void {
  const theme = ctx.ui.theme;
  if (tx) {
    const phase = tx.phase ?? "selecting";
    const pending = (currentDraft?.ranges ?? []).filter((range) => range.summary.trim().length === 0).length;
    const chars = (currentDraft?.ranges ?? []).reduce((sum, range) => sum + range.originalContentChars, 0);
    ctx.ui.setStatus(
      STATUS_KEY,
      `${theme.fg("accent", "MC " + phase)} · ${currentDraft?.ranges.length ?? 0} ranges${pending ? ` · ${pending} pending` : ""} · ${chars} chars`,
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
