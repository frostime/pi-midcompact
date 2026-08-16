import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { buildAtoms, formatLocatedAtom, locateAtoms } from "./atoms.js";
import { messageText } from "./messages.js";
import { addDraftRange, emptyDraft, formatDraft, removeDraftRange, updateDraftRange } from "./plan.js";
import { projectMessages } from "./projection.js";
import { registerStateRenderer, stateTreeLabel } from "./renderers.js";
import { showReviewUi } from "./review-ui.js";
import {
  DRAFT_ENTRY,
  STATE_ENTRY,
  TXN_ENTRY,
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
  MessageLike,
  TransactionState,
} from "./types.js";

const TOOL_NAME = "midcompact";
const TOOL_DESCRIPTION = "Locate, draft, or recall mid-context compression. Use the `midcompact` skill for workflow guidance.";
const STATUS_KEY = "midcompact";

const Params = Type.Object({
  action: StringEnum(["locate", "plan", "recall"] as const),
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
});

type ParamsType = Static<typeof Params>;

type RuntimeSnapshot = { atoms: Atom[]; anchorState?: CompressionState };

export default function (pi: ExtensionAPI) {
  let activeState: CompressionState | undefined;
  let transaction: TransactionState | undefined;
  let draft: DraftPlan | undefined;

  registerStateRenderer(pi);

  function restoreRuntime(ctx: ExtensionContext): void {
    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    activeState = restoreCompressionState(branch) ?? undefined;
    const restored = restoreTransaction(branch);
    transaction = restored.transaction;
    draft = restored.draft ?? (transaction ? emptyDraft(transaction.id) : undefined);
    updateStatus(ctx, transaction, draft);
  }

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => restoreRuntime(ctx));
  pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => restoreRuntime(ctx));
  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    activeState = undefined;
    transaction = undefined;
    draft = undefined;
  });

  pi.on("context", async (event: { messages: MessageLike[] }) => {
    if (!activeState?.blocks.length) return;
    return { messages: projectMessages(event.messages, activeState) };
  });

  pi.registerCommand("midcompact", {
    description: "Start, review, commit, inspect, or abort a branch-isolated mid-context compression transaction",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      const sub = args.trim().toLowerCase();

      if (sub === "abort") {
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
        updateStatus(ctx, transaction, draft);
        ctx.ui.notify("Midcompact transaction aborted; returned to anchor.", "info");
        return;
      }

      if (sub === "commit") {
        const restored = restoreTransaction(ctx.sessionManager.getBranch() as SessionEntry[]);
        const currentTx = restored.transaction ?? transaction;
        const currentDraft = restored.draft ?? draft;
        if (!currentTx) {
          ctx.ui.notify("No active midcompact transaction.", "warning");
          return;
        }
        if (!currentDraft?.ranges.length) {
          ctx.ui.notify("Draft is empty; nothing to commit.", "warning");
          return;
        }
        const snapshot = buildAnchorSnapshot(ctx.sessionManager, currentTx);
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
        updateStatus(ctx, transaction, draft);
        ctx.ui.notify(commitNotice(nextState), "info");
        return;
      }

      if (sub === "review") {
        await reviewTransaction(ctx);
        return;
      }

      if (sub === "status") {
        const restored = restoreTransaction(ctx.sessionManager.getBranch() as SessionEntry[]);
        const currentTx = restored.transaction ?? transaction;
        const currentDraft = restored.draft ?? draft;
        if (currentTx) {
          ctx.ui.notify(formatDraft(currentDraft ?? emptyDraft(currentTx.id), draftTelemetry(currentTx, currentDraft)), "info");
          return;
        }
        if (!activeState?.blocks.length) {
          ctx.ui.notify("No active transaction and no active midcompact blocks on this branch.", "info");
          return;
        }
        ctx.ui.notify(activeStateStatus(activeState), "info");
        return;
      }

      if (sub) {
        ctx.ui.notify("Usage: /midcompact | /midcompact review | /midcompact commit | /midcompact status | /midcompact abort", "warning");
        return;
      }

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
      transaction = {
        version: 1,
        id: `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        anchorEntryId,
        startedAt: new Date().toISOString(),
        anchorUsage: snapshotContextUsage(ctx.getContextUsage()),
      };
      draft = emptyDraft(transaction.id);
      pi.appendEntry(TXN_ENTRY, transaction);
      pi.appendEntry(DRAFT_ENTRY, draft);
      updateStatus(ctx, transaction, draft);
      const awareness = formatTelemetry(draftTelemetry(transaction, draft));
      ctx.ui.notify(`Midcompact started at anchor ${anchorEntryId}. ${compactUsage(transaction)}`, "info");
      pi.sendUserMessage([
        "A mid-compaction transaction is active on a frozen anchor snapshot.",
        awareness,
        "These numbers are context awareness, not a target or optimization constraint. Use them to judge the scale of proposed compression while preserving semantic value.",
        "Load the `midcompact` skill, use the `midcompact` tool to locate and draft compression ranges, and present the draft for user review.",
        "The Agent cannot commit. The user can inspect `/midcompact review`, then explicitly run `/midcompact commit` when satisfied.",
      ].join("\n"));
    },
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Midcompact",
    description: TOOL_DESCRIPTION,
    parameters: Params,
    async execute(_id: string, params: ParamsType, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      try {
        if (params.action === "recall") return toolResult(handleRecall(params, ctx));
        if (!transaction) return toolResult("No active midcompact transaction. Ask the user to run `/midcompact` first.");
        const snapshot = buildAnchorSnapshot(ctx.sessionManager, transaction);
        if (params.action === "locate") return toolResult(handleLocate(params, snapshot.atoms));
        if (params.action === "plan") {
          draft ??= emptyDraft(transaction.id);
          draft = handlePlan(params, draft, snapshot.atoms);
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

  async function reviewTransaction(ctx: ExtensionCommandContext): Promise<void> {
    while (true) {
      const restored = restoreTransaction(ctx.sessionManager.getBranch() as SessionEntry[]);
      const currentTx = restored.transaction ?? transaction;
      const currentDraft = restored.draft ?? draft;
      if (!currentTx) {
        ctx.ui.notify("No active midcompact transaction.", "warning");
        return;
      }
      const currentPlan = currentDraft ?? emptyDraft(currentTx.id);
      const snapshot = buildAnchorSnapshot(ctx.sessionManager, currentTx);
      const telemetry = draftTelemetry(currentTx, currentPlan);
      if (ctx.mode !== "tui") {
        ctx.ui.notify(formatDraft(currentPlan, telemetry), "info");
        return;
      }
      const action = await showReviewUi(ctx, snapshot.atoms, currentPlan, telemetry);
      if (action.action === "close") return;
      const range = currentPlan.ranges.find((candidate) => candidate.id === action.draftId);
      if (!range) continue;

      if (action.action === "edit-summary") {
        const value = await ctx.ui.editor(`Edit ${range.id} summary`, range.summary);
        if (value === undefined || !value.trim()) continue;
        draft = updateDraftRange(currentPlan, range.id, { summary: value.trim() });
        pi.appendEntry(DRAFT_ENTRY, draft);
        updateStatus(ctx, currentTx, draft);
        continue;
      }
      if (action.action === "edit-topic") {
        const value = await ctx.ui.input(`Edit ${range.id} topic`, range.topic ?? "");
        if (value === undefined) continue;
        draft = updateDraftRange(currentPlan, range.id, { topic: value.trim() || undefined });
        pi.appendEntry(DRAFT_ENTRY, draft);
        updateStatus(ctx, currentTx, draft);
        continue;
      }
      if (action.action === "remove") {
        const approved = await ctx.ui.confirm("Remove compression range?", `${range.id}: ${range.startRef} → ${range.endRef}`);
        if (!approved) continue;
        draft = removeDraftRange(currentPlan, range.id);
        pi.appendEntry(DRAFT_ENTRY, draft);
        updateStatus(ctx, currentTx, draft);
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
        `${block.id}${block.topic ? ` | ${block.topic}` : ""} | ~${block.originalApproxTokens} original tokens\n${block.summary}`
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
  if (!params.start || !params.end || !params.summary) throw new Error("plan add requires start, end, and summary.");
  return addDraftRange(current, atoms, { start: params.start, end: params.end, summary: params.summary, topic: params.topic });
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
    selectedOriginalApproxTokens: telemetry.selectedOriginalApproxTokens,
    selectedCompressedApproxTokens: telemetry.selectedCompressedApproxTokens,
    estimatedSavedTokens: telemetry.estimatedSavedTokens,
    anchorUsage: transaction.anchorUsage,
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
    const telemetry = draftTelemetry(tx, currentDraft);
    const projected = telemetry.projectedPercent === null ? "" : ` · projected ${formatPercent(telemetry.projectedPercent, true)}`;
    ctx.ui.setStatus(
      STATUS_KEY,
      `${theme.fg("accent", "MC planning")} · ${currentDraft?.ranges.length ?? 0} ranges${projected}`,
    );
    return;
  }
  ctx.ui.setStatus(STATUS_KEY, undefined);
}

function compactUsage(tx: TransactionState): string {
  const usage = tx.anchorUsage;
  if (!usage) return "Anchor context usage unavailable.";
  return `Anchor context ${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)} (${formatPercent(usage.percent)}).`;
}

function activeStateStatus(state: CompressionState): string {
  const saved = state.blocks.reduce(
    (sum, block) => sum + Math.max(0, block.originalApproxTokens - block.compressedApproxTokens),
    0,
  );
  return `Midcompact active on this branch: ${state.blocks.length} block(s), ~${formatTokenCount(saved)} estimated tokens saved. Original history remains recallable.`;
}

function commitNotice(state: CompressionState): string {
  const commit = state.lastCommit;
  if (!commit) return `Midcompact committed: ${state.blocks.length} active compressed block(s).`;
  const projection = commit.projectedPercent === null
    ? ""
    : ` Projected anchor context ${formatPercent(commit.anchorUsage?.percent ?? null)} → ${formatPercent(commit.projectedPercent, true)}.`;
  return `Midcompact committed: ${commit.addedRangeCount} new range(s), ~${formatTokenCount(commit.estimatedSavedTokens)} estimated tokens saved.${projection}`;
}

function toolResult(text: string) {
  return { content: [{ type: "text", text }], details: {} };
}
