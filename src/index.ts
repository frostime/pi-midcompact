import { Type, type Static } from "@earendil-works/pi-ai";
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
import {
  DRAFT_ENTRY,
  STATE_ENTRY,
  TXN_ENTRY,
  emptyCompressionState,
  restoreCompressionState,
  restoreTransaction,
} from "./state.js";
import type {
  Atom,
  CompressionBlock,
  CompressionState,
  DraftPlan,
  MessageLike,
  TransactionState,
} from "./types.js";

const TOOL_NAME = "midcompact";
const TOOL_DESCRIPTION = "Locate, draft, or recall mid-context compression. Use the `midcompact` skill for workflow guidance.";

const Params = Type.Object({
  action: Type.Union([
    Type.Literal("locate"),
    Type.Literal("plan"),
    Type.Literal("recall"),
  ]),
  ref: Type.Optional(Type.String()),
  pattern: Type.Optional(Type.String()),
  source: Type.Optional(Type.Union([
    Type.Literal("any"),
    Type.Literal("user"),
    Type.Literal("assistant"),
    Type.Literal("tool_call"),
    Type.Literal("tool_result"),
  ])),
  tool_name: Type.Optional(Type.String()),
  direction: Type.Optional(Type.Union([Type.Literal("oldest"), Type.Literal("newest")])),
  limit: Type.Optional(Type.Number()),
  detail: Type.Optional(Type.Union([Type.Literal("brief"), Type.Literal("full")])),
  op: Type.Optional(Type.Union([Type.Literal("show"), Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")])),
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

  function restoreRuntime(sm: ExtensionContext["sessionManager"]): void {
    const branch = sm.getBranch() as SessionEntry[];
    activeState = restoreCompressionState(branch) ?? undefined;
    const restored = restoreTransaction(branch);
    transaction = restored.transaction;
    draft = restored.draft ?? (transaction ? emptyDraft(transaction.id) : undefined);
  }

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => restoreRuntime(ctx.sessionManager));
  pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => restoreRuntime(ctx.sessionManager));
  pi.on("session_shutdown", async () => {
    activeState = undefined;
    transaction = undefined;
    draft = undefined;
  });

  pi.on("context", async (event: { messages: MessageLike[] }) => {
    if (!activeState?.blocks.length) return;
    return { messages: projectMessages(event.messages, activeState) };
  });

  pi.registerCommand("midcompact", {
    description: "Start, commit, inspect, or abort a branch-isolated mid-context compression transaction",
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
        const nextState = mergeDraftIntoState(snapshot.anchorState, currentDraft);
        const result = await ctx.navigateTree(currentTx.anchorEntryId, { summarize: false });
        if (result.cancelled) {
          ctx.ui.notify("Midcompact commit cancelled by tree navigation.", "warning");
          return;
        }
        pi.appendEntry(STATE_ENTRY, nextState);
        activeState = nextState;
        transaction = undefined;
        draft = undefined;
        ctx.ui.notify(
          `Midcompact committed: ${currentDraft.ranges.length} new range(s), ${nextState.blocks.length} active compressed block(s).`,
          "info",
        );
        return;
      }
      if (sub === "status") {
        if (!transaction) {
          ctx.ui.notify(`No active transaction. Active compressed blocks: ${activeState?.blocks.length ?? 0}.`, "info");
          return;
        }
        ctx.ui.notify(`Transaction ${transaction.id} at ${transaction.anchorEntryId}; ${draft?.ranges.length ?? 0} draft range(s).`, "info");
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
      };
      draft = emptyDraft(transaction.id);
      pi.appendEntry(TXN_ENTRY, transaction);
      pi.appendEntry(DRAFT_ENTRY, draft);
      ctx.ui.notify(`Midcompact started at anchor ${anchorEntryId}.`, "info");
      await pi.sendUserMessage([
        "A mid-compaction transaction is active on a frozen anchor snapshot.",
        "Load the `midcompact` skill, use the `midcompact` tool to locate and draft compression ranges, and present the draft for user review.",
        "The Agent cannot commit. After review, ask the user to run `/midcompact commit`; that explicit command is the commit gate.",
      ].join("\n"));
    },
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Midcompact",
    description: TOOL_DESCRIPTION,
    parameters: Params,
    async execute(_id: string, params: ParamsType, _signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
      try {
        if (params.action === "recall") return toolResult(handleRecall(params, ctx));
        if (!transaction) return toolResult("No active midcompact transaction. Ask the user to run `/midcompact` first.");
        const snapshot = buildAnchorSnapshot(ctx.sessionManager, transaction);
        if (params.action === "locate") return toolResult(handleLocate(params, snapshot.atoms));
        if (params.action === "plan") {
          draft ??= emptyDraft(transaction.id);
          draft = handlePlan(params, draft, snapshot.atoms);
          pi.appendEntry(DRAFT_ENTRY, draft);
          return toolResult(formatDraft(draft));
        }
        return toolResult("Unknown action.");
      } catch (error) {
        return toolResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });



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

function mergeDraftIntoState(base: CompressionState | undefined, draft: DraftPlan): CompressionState {
  const previous = base ?? emptyCompressionState();
  const blocks = [...previous.blocks];
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
    next += 1;
  }
  return { version: 1, createdAt: new Date().toISOString(), blocks };
}

function nextBlockNumber(blocks: CompressionBlock[]): number {
  let max = 0;
  for (const block of blocks) {
    const match = /^c(\d+)$/.exec(block.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function toolResult(text: string) {
  return { content: [{ type: "text", text }], details: {} };
}
