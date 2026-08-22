---
name: midcompact
description: Use when a midcompact runtime prompt starts or hands off a compression-planning transaction, or when current work needs details from an active committed midcompact block. Guides user-aligned candidate discovery, effort-scaled inspect/locate/plan work, replacement-summary writing, and recall.
---

# Midcompact

## Route the activation

This skill handles two independent tasks: planning compression and recalling committed content. Choose the route before calling the tool.

| Signal | Immediate duty | First action |
|--------|----------------|--------------|
| Runtime prompt says `FINAL STATE: USER MANUAL` | Let the user create the initial DraftPlan | Reply exactly `OK`; call no midcompact tool |
| Runtime prompt says `FINAL STATE: AGENT DIRECT` | Start from the new empty draft | `action="inspect"` |
| A handoff reports a persisted DraftPlan and the user asks to continue | Read the shared selection and determine what help the user wants | `action="plan", op="show"` |
| The user or a projected summary needs detail from a committed block | Retrieve that history only | Follow **Recall workflow** |

The state-specific runtime prompt is authoritative. Recall does not enter planning or mutate the DraftPlan. During the User-manual acknowledgement turn, the no-tool instruction overrides every other route.

## Plan compression

Selected ranges become summaries in future model context; content outside them stays verbatim. Originals remain stored, but recall is a recovery path, not a substitute for a sufficient summary. Agent and user edit one DraftPlan; the user retains final control through review and `/midcompact commit`.

The start mode controls how the first draft is created. It does not determine whether a user selection is final, how much initiative the Agent should take, or how deeply the history should be investigated.

Apply one invariant:

> Every fact that can still affect future work must remain with sufficient fidelity, either outside the selected ranges or in their replacement summaries.

### Planning workflow

#### 1. Read the entry state and user intent

For a fresh Agent-direct transaction, begin with `action="inspect"`. For a handed-off DraftPlan, begin with `action="plan", op="show"`; inspect the anchor only if the requested work needs broader context.

Establish the user's desired scope, fidelity, and planning effort from their words, current selection, `User focus: ...`, and surrounding interaction. Treat answers collected through question, questionnaire, or similar tools as user-originated input even when represented as tool results.

A manual selection records what the user selected, not whether they mean "only this" or "help me refine it." Follow a clear intent directly. If different interpretations would materially change the work, ask briefly whether to limit work to the selection or inspect and suggest changes. Do not force clarification when the user has already expressed a preference or delegated the judgment.

Match effort to the requested fidelity. A quick or approximate request calls for bounded planning; a precision-sensitive request may justify deeper work after alignment.

#### 2. Form a bounded semantic view

`inspect` returns factual structure with bounded user landmarks, grouped by user message. Use it for structure and volume, not to invent semantics. Ground candidates in visible conversation or a few targeted `locate` calls, and stop paging after the potentially relevant region. When exact candidate spans are known and their relative volume could change the choice, use read-only `inspect` spans to compare them without mutating the DraftPlan.

Segment by completed work phase, not message count. User-originated input and concluding Agent responses are useful landmarks for intent and outcome, but are not automatically KEEP. Intermediate tool exchanges may also contain decisions or evidence absent from the final response.

| Often able to yield to a summary | Often load-bearing |
|-----------------------------------|--------------------|
| Repetitive or superseded exploration | Current intent and active constraints |
| Tool output absorbed into a conclusion | Exact errors, evidence, or wording whose form matters |
| A completed subtask's intermediate process | Decisions and rationale still governing the work |
| A rejected attempt's mechanics | Its still-relevant failure reason |

Use little or no `locate` during this reconnaissance. If a phase cannot yet be described faithfully, omit it from the proposal or mark it as needing confirmation rather than exploring the anchor broadly.

#### 3. Present semantic options and align

Before deep `locate` work or substantial DraftPlan mutation, establish the user's compression preference through explicit instruction, a reliable implication, or concise clarification.

Describe each proposal in recognizable conversation terms:

> From `<semantic start>` to `<semantic end>`, `<replace the whole phase / keep the endpoints and compress the work between>`; preserve `<load-bearing information>` in the summary.

Use short recognizable excerpts when available and clear paraphrases otherwise. State whether the endpoint messages remain verbatim, what intermediate work disappears, and what the summary carries. Do not identify a user-facing range primarily by atom refs, DraftPlan ids, or arbitrary item numbers.

When treatments involve a meaningful tradeoff, present concise alternatives and recommend one. A clear quick request may need only one proportionate proposal. Add factual content or image measurements only when they help the choice, and do not convert them into unsupported token-savings claims.

#### 4. Resolve boundaries and build the DraftPlan

After the intended treatment is clear, use `action="locate"` for targeted content and boundary checks. An atom is the smallest selectable unit; a tool call and its matching results form one indivisible `tool_exchange` atom. Keep source text outside a range when exact wording or provenance matters and a summary cannot preserve it equivalently.

Choose boundaries from the information that must survive, not from a fixed category. A range may replace a whole semantic phase, including its initiating and concluding messages. It may instead retain a load-bearing user instruction and concluding Agent response while replacing only the execution between them. It may split around important material to leave KEEP holes. These are reasoning patterns, not rules tied to start mode, message age, or one prescribed kind of work.

Build or refine the shared DraftPlan with `plan add`, `update`, `remove`, and `show`. A handed-off selection may be preserved or revised as the user's intent permits. Use separate ranges for non-contiguous phases; fill pending summaries before commit. If deeper inspection would materially change the agreed treatment, surface the change instead of silently applying it.

Read `references/tool-interface.md` before retrying a rejected operation or when exact parameters, protected-atom causes, or measurements matter.

#### 5. Write replacement summaries

A replacement summary is successor context for a future Agent, not a transcript or a prompt to perform compression. State the resulting knowledge and working state directly.

Preserve, when applicable:

- user intent and active constraints;
- decisions, conclusions, and necessary rationale;
- relevant files, symbols, interfaces, commands, or configuration;
- completed changes and validation results;
- rejected approaches only when their failure reason still matters;
- unresolved issues and any established next step or continuation state.

Remove repetitive exploration, superseded hypotheses, raw output captured by a conclusion, and chronology with no remaining consequence. Do not turn uncertainty into fact, invent a next action, or use references that only make sense inside the removed text. If retained endpoint messages already carry part of the intended context, do not duplicate them mechanically; use the summary to preserve what would otherwise be lost.

Organize by future utility rather than original chronology. When useful, use this compact frame without forcing empty fields:

```text
Goal and constraints:
Established state and decisions:
Artifacts and validation:
Open issues and established next state:
```

Length follows the information that must survive, not a target ratio. Final test: could a fresh Agent continue correctly from this summary plus retained context, without repeating work or violating a prior decision?

#### 6. Verify and hand off

Call `action="plan", op="show"`. Check that the intended semantic phases are covered, KEEP holes remain outside ranges, every range has a summary, and the summaries conserve the future working state.

Describe the completed proposal with the same recognizable landmarks used during alignment. Direct the user to `/midcompact select` or `/midcompact select-webui` for boundaries and KEEP holes, and to `/midcompact review` or `/midcompact review-webui` for summary inspection or rejection. Use browser variants when the TUI is unavailable or preferred. Ask the user to run `/midcompact commit` when ready; never commit for them.

## Recall compressed content

Recall works with or without an active planning transaction. It reads committed blocks active on the current branch without changing projection or DraftPlan.

### Recall workflow

#### 1. Find the block

If its id is unknown, call `action="recall", pattern="..."` to search active topics and summaries. A projected summary also states its block id and exact recall call.

#### 2. Retrieve the detail

Call `action="recall", ref="c0001"`. If the readable, structure-flattened result ends with a truncation marker, retry with `detail="full"`. Retrieve only what the current task needs; do not start or change a plan merely to recall history.

## Tool conventions

- `g0001` labels an inventory group; use its `a...` span as internal landmarks.
- `a0001` is a transaction-local atom ref; `d1` is a DraftPlan range id; `c0001` is an active committed-block id.
- Protected atoms cannot enter a range. Split around them.

These refs are planning handles, not the primary way to explain compression to the user. Read `references/tool-interface.md` for exact defaults and limits, rejected operations, protected-atom causes, measurements, repeated compression, or recall truncation.
