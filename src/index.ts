import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
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
import { parseSurfaceRequest, resolvePlanningSurface, type PlanningSurfaceRequest } from "./surface-ui.js";
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
  "Inspect, measure, locate, plan, or recall mid-context compression. Use the `midcompact` skill to route planning versus recall; during an active transaction, follow the runtime prompt for the state-specific first action.";
const STATUS_KEY = "midcompact";
const START_PROMPT_PREFIX = "A mid-compaction transaction is active on a frozen anchor snapshot.";

// Canonical request model: one branch per operation, and each branch owns
// exactly its own fields (additionalProperties: false). Second-level operation
// discriminators (the former plan `op`, locate ref-vs-filter, recall
// list-vs-render, inspect inventory-vs-spans) are flattened into top-level
// branches so field legality is visible in the schema itself. The discriminant
// is a single-value StringEnum instead of Type.Literal so it serializes as
// string+enum, which restricted JSON-Schema subsets (e.g. DeepSeek) accept
// more readily than const.
//
// The union sits under a root `request` property instead of being the
// parameters root: some providers validate that a tool's parameters root is
// `type: "object"` and reject a root-level anyOf before the model ever sees
// the schema (observed on DeepSeek). Field descriptions stay in sync with
// skills/midcompact/references/tool-interface.md.
const InspectRequest = Type.Object(
  {
    action: StringEnum(["inspect"] as const, { description: "Page through the frozen anchor inventory: groups, refs, sizes, protected/compressible counts." }),
    page_size: Type.Optional(Type.Number({ description: "Groups per page (default 20, max 50; out-of-range values are clamped)." })),
    cursor: Type.Optional(Type.String({ description: "Pagination cursor from the previous page." })),
  },
  { additionalProperties: false },
);

const MeasureRequest = Type.Object(
  {
    action: StringEnum(["measure"] as const, { description: "Measure candidate {start,end} atom spans without changing the plan." }),
    candidates: Type.Array(
      Type.Object({ start: Type.String({ description: "Candidate start atom ref." }), end: Type.String({ description: "Candidate end atom ref." }) }),
      { minItems: 1, description: "Candidate spans to measure, e.g. [{start:\"a0006\",end:\"a0014\"}]." },
    ),
  },
  { additionalProperties: false },
);

const LocateRefRequest = Type.Object(
  {
    action: StringEnum(["locate_ref"] as const, { description: "Look up one atom by ref in the frozen anchor." }),
    ref: Type.String({ description: "Atom ref, e.g. a0001. Group labels shown by inspect are not atom refs." }),
    detail: Type.Optional(StringEnum(["brief", "full"] as const, { description: "brief (default) bounded preview; full atom text up to 12,000 characters." })),
  },
  { additionalProperties: false },
);

const LocateSearchRequest = Type.Object(
  {
    action: StringEnum(["locate_search"] as const, { description: "Search anchor atoms with at least one filter; filters combine conjunctively (AND)." }),
    pattern: Type.Optional(Type.String({ description: "Case-insensitive substring filter over atom text." })),
    source: Type.Optional(StringEnum(["user", "assistant", "tool_call", "tool_result"] as const, { description: "Filter by entry source class." })),
    tool_name: Type.Optional(Type.String({ description: "Exact (case-insensitive) match on the originating tool name." })),
    direction: Type.Optional(StringEnum(["oldest", "newest"] as const, { description: "Match ordering, oldest (default) or newest." })),
    limit: Type.Optional(Type.Number({ description: "1-3 results (out-of-range values are clamped)." })),
  },
  { additionalProperties: false },
);

const PlanShowRequest = Type.Object(
  {
    action: StringEnum(["plan_show"] as const, { description: "List every plan range in brief form with plan telemetry." }),
  },
  { additionalProperties: false },
);

const PlanReadRequest = Type.Object(
  {
    action: StringEnum(["plan_read"] as const, { description: "Read one plan range in full: stored summary and endpoint previews under a 40,000-character budget." }),
    range_id: Type.String({ description: "Target range id from plan_show, e.g. d1." }),
  },
  { additionalProperties: false },
);

const PlanAddRequest = Type.Object(
  {
    action: StringEnum(["plan_add"] as const, { description: "Add one range over contiguous atoms; boundaries are immutable after add." }),
    start: Type.String({ description: "Range start atom ref." }),
    end: Type.String({ description: "Range end atom ref (inclusive)." }),
    summary: Type.Optional(Type.String({ description: "Replacement summary; omitted or empty leaves the range pending." })),
    topic: Type.Optional(Type.String({ description: "Optional range topic." })),
  },
  { additionalProperties: false },
);

const PlanUpdateRequest = Type.Object(
  {
    action: StringEnum(["plan_update"] as const, { description: "Update one range's summary and/or topic; boundaries change via plan_remove + plan_add." }),
    range_id: Type.String({ description: "Target range id, e.g. d1." }),
    summary: Type.Optional(Type.String({ description: "New summary; empty string marks the range pending." })),
    topic: Type.Optional(Type.String({ description: "New topic." })),
  },
  { additionalProperties: false },
);

const PlanRemoveRequest = Type.Object(
  {
    action: StringEnum(["plan_remove"] as const, { description: "Remove one range from the plan." }),
    range_id: Type.String({ description: "Target range id, e.g. d1." }),
  },
  { additionalProperties: false },
);

const RecallListRequest = Type.Object(
  {
    action: StringEnum(["recall_list"] as const, { description: "List committed blocks; works without a transaction." }),
    pattern: Type.Optional(Type.String({ description: "Case-insensitive filter over block id, topic, and summary (not original content)." })),
    limit: Type.Optional(Type.Number({ description: "Blocks to list (default 8, max 20; out-of-range values are clamped)." })),
  },
  { additionalProperties: false },
);

const RecallReadRequest = Type.Object(
  {
    action: StringEnum(["recall_read"] as const, { description: "Render one committed block's original messages." }),
    block: Type.String({ description: "Committed block id, e.g. c0001." }),
    detail: Type.Optional(StringEnum(["brief", "full"] as const, { description: "full raises the rendering cap from 12,000 to 40,000 characters on truncated blocks." })),
  },
  { additionalProperties: false },
);

const Params = Type.Object(
  {
    request: Type.Union([
      InspectRequest,
      MeasureRequest,
      LocateRefRequest,
      LocateSearchRequest,
      PlanShowRequest,
      PlanReadRequest,
      PlanAddRequest,
      PlanUpdateRequest,
      PlanRemoveRequest,
      RecallListRequest,
      RecallReadRequest,
    ]),
  },
  {
    additionalProperties: false,
    description: "`request.action` selects exactly one request shape; each shape accepts only its own fields.",
  },
);

type ToolParams = Static<typeof Params>;
type InspectRequestType = Static<typeof InspectRequest>;
type MeasureRequestType = Static<typeof MeasureRequest>;
type LocateRefRequestType = Static<typeof LocateRefRequest>;
type LocateSearchRequestType = Static<typeof LocateSearchRequest>;
type PlanShowRequestType = Static<typeof PlanShowRequest>;
type PlanReadRequestType = Static<typeof PlanReadRequest>;
type PlanAddRequestType = Static<typeof PlanAddRequest>;
type PlanUpdateRequestType = Static<typeof PlanUpdateRequest>;
type PlanRemoveRequestType = Static<typeof PlanRemoveRequest>;
type RecallListRequestType = Static<typeof RecallListRequest>;
type RecallReadRequestType = Static<typeof RecallReadRequest>;

// Runtime closure backstop: providers are not trusted to enforce
// additionalProperties at call time, and a silently ignored field is worse
// than a rejection. Keys are the per-branch optional/required fields besides
// the discriminant.
const BRANCH_FIELDS: Record<ToolParams["request"]["action"], readonly string[]> = {
  inspect: ["page_size", "cursor"],
  measure: ["candidates"],
  locate_ref: ["ref", "detail"],
  locate_search: ["pattern", "source", "tool_name", "direction", "limit"],
  plan_show: [],
  plan_read: ["range_id"],
  plan_add: ["start", "end", "summary", "topic"],
  plan_update: ["range_id", "summary", "topic"],
  plan_remove: ["range_id"],
  recall_list: ["pattern", "limit"],
  recall_read: ["block", "detail"],
};

function rejectExtraFields(request: ToolParams["request"]): void {
  const allowed: readonly string[] = BRANCH_FIELDS[request.action];
  const extras = Object.keys(request).filter((key) => key !== "action" && !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${request.action} does not accept: ${extras.join(", ")}.`);
}

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
          "An active midcompact transaction exists with a persisted plan.",
          `Plan revision ${currentDraft.revision}; ${currentDraft.ranges.length} existing range(s), which may have been created by the user.`,
          "If the current user request asks to continue midcompact, read the `midcompact` skill first, then call midcompact(request={action:\"plan_show\"}) before any other midcompact action. Treat the existing plan as the shared starting point. Infer from the user's request whether to preserve, refine, or extend it; ask only if materially ambiguous.",
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

  // One command per operation; the `midcompact:` prefix follows the same
  // naming convention as Pi's own `skill:<name>` commands. The former
  // composite `/midcompact <subcommand>` command is gone.
  pi.registerCommand("midcompact:start", {
    description: "Start a new midcompact transaction at the current anchor. Optional trailing text becomes the initial focus.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      return startTransaction(ctx, args.trim() || undefined);
    },
  });
  pi.registerCommand("midcompact:abort", {
    description: "Abort the active transaction and return to the anchor",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      return abortTransaction(ctx);
    },
  });
  pi.registerCommand("midcompact:commit", {
    description: "Commit the current plan to the branch state",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      return commitTransaction(ctx);
    },
  });
  pi.registerCommand("midcompact:review", {
    description: "Open Review; optionally choose the tui or webui surface",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      const parsed = parseSurfaceRequest(args, "review");
      if (!parsed.request) {
        ctx.ui.notify(parsed.usage!, "warning");
        return;
      }
      return reviewTransaction(ctx, parsed.request);
    },
  });
  pi.registerCommand("midcompact:review-webui", {
    description: "Compatibility alias for /midcompact:review webui",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      return reviewTransaction(ctx, "webui");
    },
  });
  pi.registerCommand("midcompact:select", {
    description: "Open Selection; optionally choose the tui or webui surface",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      const parsed = parseSurfaceRequest(args, "select");
      if (!parsed.request) {
        ctx.ui.notify(parsed.usage!, "warning");
        return;
      }
      return openSelectionUi(ctx, parsed.request);
    },
  });
  pi.registerCommand("midcompact:select-webui", {
    description: "Compatibility alias for /midcompact:select webui",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      return openSelectionUi(ctx, "webui");
    },
  });
  pi.registerCommand("midcompact:status", {
    description: "Show current transaction and plan status",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      return showStatus(ctx);
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
    if (modeChoice === "unrecognized") {
      ctx.ui.notify("Midcompact start cancelled: the dialog returned an unrecognized choice.", "warning");
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
    await openSelectionUi(ctx, "choose");
  }

  async function chooseStartMode(ctx: ExtensionCommandContext): Promise<StartMode | "cancelled" | "unrecognized"> {
    // The standard `select` dialog works identically in TUI and RPC; modes
    // without any UI (json/print) cannot prompt and default to Agent-first.
    if (!ctx.hasUI) return "agent";
    return showStartChoice(ctx);
  }

  async function openSelectionUi(ctx: ExtensionCommandContext, request: PlanningSurfaceRequest): Promise<void> {
    const currentTx = transaction;
    if (!currentTx || !draft) {
      ctx.ui.notify("No active midcompact transaction.", "warning");
      return;
    }
    if (!tryAcquireUi(planningLock)) {
      ctx.ui.notify("The Agent is currently processing the midcompact plan. Try Selection after the Agent turn ends.", "warning");
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
      const surface = await resolvePlanningSurface(ctx, request, "select");
      if (!surface) return;
      if (surface === "tui") {
        const action = await showSelectionUi(ctx, snapshot.atoms, draft, draftTelemetry(currentTx, draft));
        if (action.action === "save") {
          try {
            applySelection(action.spans ?? [], action.keepRefs ?? []);
            ctx.ui.notify("Plan saved. Tell the Agent to continue processing it when ready.", "info");
          } catch (error) {
            ctx.ui.notify(`Selection could not be saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
          }
        } else {
          ctx.ui.notify("Selection closed. The plan remains available; reopen select or tell the Agent to continue.", "info");
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
      ctx.ui.notify("Selection closed. The plan is saved; tell the Agent to continue when ready.", "info");
    } finally {
      releaseUi(planningLock);
    }
  }

  async function sendAgentStartPrompt(tx: TransactionState, customInstructions: string | undefined, mode: StartMode): Promise<void> {
    const awareness = formatTelemetry(draftTelemetry(tx, draft));
    const promptLines = [
      START_PROMPT_PREFIX,
      awareness,
      "The extension provides inspect for the bounded inventory, measure for candidate spans, locate for atom details, plan_show/plan_read/plan_add/plan_update/plan_remove for one shared plan, and recall_list/recall_read for committed blocks.",
      "The user owns the final compression decision. You may edit the plan, but you must not commit. Preserve facts that future work still needs; local character and image counts are not token estimates.",
    ];
    if (customInstructions) promptLines.push(`User focus: ${customInstructions}`);
    if (mode === "agent") {
      promptLines.push(
        "FINAL STATE: AGENT DIRECT. The new plan is empty. Read the `midcompact` skill before doing any planning work, then call inspect first and use measure, locate, and the plan actions to create ranges and summaries. Stop before commit.",
      );
    } else {
      promptLines.push(
        "FINAL STATE: USER MANUAL. The user is about to edit the initial plan. Acknowledge with OK only. Do not call any midcompact action; do not change the plan or commit. Wait until the user finishes editing and sends a later request. On that later request, read the `midcompact` skill before doing any planning work, then call plan_show first.",
      );
    }
    await pi.sendUserMessage(promptLines.join("\n"));
  }

  async function abortTransaction(ctx: ExtensionCommandContext): Promise<void> {
    if (planningLock.owner === "agent") {
      ctx.ui.notify("The Agent is currently processing the midcompact plan. Abort after the Agent turn ends.", "warning");
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
      ctx.ui.notify("The Agent is currently processing the midcompact plan. Commit after the Agent turn ends.", "warning");
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
      ctx.ui.notify("Plan is empty; nothing to commit.", "warning");
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

  async function reviewTransaction(ctx: ExtensionCommandContext, request: PlanningSurfaceRequest): Promise<void> {
    const restored = restoreTransaction(ctx.sessionManager.getBranch() as SessionEntry[]);
    const currentTx = withCompatDefaults(restored.transaction ?? transaction);
    const currentDraft = restored.draft ?? draft;
    if (!currentTx) {
      ctx.ui.notify("No active midcompact transaction.", "warning");
      return;
    }
    if (!tryAcquireUi(planningLock)) {
      ctx.ui.notify("The Agent is currently processing the midcompact plan. Try opening review after the Agent turn ends.", "warning");
      return;
    }
    try {
      const surface = await resolvePlanningSurface(ctx, request, "review");
      if (!surface) return;
      const snapshot = buildAnchorSnapshot(ctx.sessionManager, currentTx);

      const commitMutation = (next: DraftPlan): void => {
        draft = next;
        pi.appendEntry(DRAFT_ENTRY, next);
        updateStatus(ctx, currentTx, next, planningLock.owner);
      };

    if (surface === "webui") {
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
      ctx.ui.notify("A Selection/Review UI is currently editing the midcompact plan. Close it before the Agent can continue.", "warning");
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
    async execute(_id: string, params: ToolParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      try {
        const request = params.request;
        rejectExtraFields(request);
        if (request.action === "recall_list") return toolResult(handleRecallList(request, ctx));
        if (request.action === "recall_read") return toolResult(handleRecallRead(request, ctx));
        const restored = restoreTransaction(ctx.sessionManager.getBranch() as SessionEntry[]);
        const currentTx = withCompatDefaults(restored.transaction ?? transaction);
        if (!currentTx) return toolResult("No active midcompact transaction. Ask the user to run `/midcompact:start` first.");
        transaction = currentTx;
        draft = restored.draft ? { ...restored.draft, ranges: restored.draft.ranges.map(coerceDraftRange) } : (draft ?? emptyDraft(currentTx.id));
        if (!requireAgentAccess(ctx)) {
          return toolResult("Agent operation blocked: a user editing UI holds the planning lock.");
        }
        const snapshot = buildAnchorSnapshot(ctx.sessionManager, currentTx);

        if (request.action === "inspect") return toolResult(handleInventory(request, snapshot.atoms, currentTx));
        if (request.action === "measure") return toolResult(handleMeasure(request, snapshot.atoms));
        if (request.action === "locate_ref") return toolResult(handleLocateRef(request, snapshot.atoms));
        if (request.action === "locate_search") return toolResult(handleLocateSearch(request, snapshot.atoms));
        if (request.action === "plan_show") {
          return toolResult(formatDraft(draft!, draftTelemetry(transaction, draft), { atoms: snapshot.atoms }));
        }
        if (request.action === "plan_read") {
          return toolResult(formatDraft(draft!, draftTelemetry(transaction, draft), {
            detail: "full",
            draftId: request.range_id,
            atoms: snapshot.atoms,
          }));
        }
        if (request.action === "plan_add" || request.action === "plan_update" || request.action === "plan_remove") {
          const result = handlePlanMutation(draft!, snapshot.atoms, request);
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

  function handleInventory(params: InspectRequestType, atoms: Atom[], tx: TransactionState): string {
    const page = buildInventory(atoms, { pageSize: params.page_size, cursor: params.cursor }, { transaction: tx });
    return formatInventory(page);
  }

  function handleMeasure(params: MeasureRequestType, atoms: Atom[]): string {
    if (!params.candidates?.length) throw new Error("measure requires at least one start/end candidate.");
    return formatSpanInspection(atoms, params.candidates);
  }

  function restoreBranchState(ctx: ExtensionContext): CompressionState | undefined {
    return restoreCompressionState(ctx.sessionManager.getBranch() as SessionEntry[]) ?? activeState;
  }

  function handleRecallList(params: RecallListRequestType, ctx: ExtensionContext): string {
    const branchState = restoreBranchState(ctx);
    if (!branchState?.blocks.length) return "No compressed blocks are active on this branch.";
    const query = (params.pattern ?? "").trim().toLocaleLowerCase();
    const matches = branchState.blocks.filter((block) => !query || `${block.id}\n${block.topic ?? ""}\n${block.summary}`.toLocaleLowerCase().includes(query));
    if (!matches.length) return "No compressed blocks matched.";
    return matches.slice(0, Math.max(1, Math.min(params.limit ?? 8, 20))).map((block) =>
      `${block.id}${block.topic ? ` | ${block.topic}` : ""} | ${block.originalContentChars ?? 0} original chars${block.originalImageCount ? ` · ${block.originalImageCount} images` : ""}\n${block.summary}`
    ).join("\n\n");
  }

  function handleRecallRead(params: RecallReadRequestType, ctx: ExtensionContext): string {
    const sm = ctx.sessionManager;
    const branchState = restoreBranchState(ctx);
    if (!branchState?.blocks.length) return "No compressed blocks are active on this branch.";
    const block = branchState.blocks.find((candidate) => candidate.id === params.block);
    if (!block) return `Unknown compressed block ${params.block}.`;
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

function handleLocateRef(params: LocateRefRequestType, atoms: Atom[]): string {
  const result = locateAtomMatches(atoms, { ref: params.ref });
  if (!result.atoms.length) return "No matching atoms in the frozen anchor snapshot.";
  return formatLocatedAtom(result.atoms[0]!, params.detail ?? "brief");
}

function handleLocateSearch(params: LocateSearchRequestType, atoms: Atom[]): string {
  if (!params.pattern && !params.tool_name && !params.source) {
    throw new Error("locate_search requires at least one filter: pattern, tool_name, or source.");
  }
  const result = locateAtomMatches(atoms, {
    pattern: params.pattern,
    source: params.source,
    toolName: params.tool_name,
    direction: params.direction,
    limit: params.limit,
  });
  if (!result.atoms.length) return "No matching atoms in the frozen anchor snapshot.";
  const rendered = result.atoms
    .map((atom) => formatLocatedAtom(atom, "brief", params.pattern))
    .join("\n\n---\n\n");
  if (result.totalMatches <= result.atoms.length) return rendered;
  return [
    `Showing ${result.atoms.length} of ${result.totalMatches} matches (${params.direction ?? "oldest"} first). Refine pattern or add source or tool_name.`,
    rendered,
  ].join("\n\n");
}

type PlanMutationOp = "add" | "update" | "remove";

function handlePlanMutation(
  current: DraftPlan,
  atoms: Atom[],
  request: PlanAddRequestType | PlanUpdateRequestType | PlanRemoveRequestType,
): { op: PlanMutationOp; draft: DraftPlan; changedId: string } {
  if (request.action === "plan_add") {
    const draft = addDraftRange(current, atoms, { start: request.start, end: request.end, summary: request.summary, topic: request.topic });
    const previousIds = new Set(current.ranges.map((range) => range.id));
    const changedId = draft.ranges.find((range) => !previousIds.has(range.id))!.id;
    return { op: "add", draft, changedId };
  }
  if (request.action === "plan_update") {
    if (request.summary === undefined && request.topic === undefined) {
      throw new Error("plan_update requires summary and/or topic; boundaries change via plan_remove + plan_add.");
    }
    return {
      op: "update",
      draft: updateDraftRange(current, request.range_id, { summary: request.summary, topic: request.topic }),
      changedId: request.range_id,
    };
  }
  return { op: "remove", draft: removeDraftRange(current, request.range_id), changedId: request.range_id };
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
