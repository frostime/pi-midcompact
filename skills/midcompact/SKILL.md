---
name: midcompact
description: Use when a midcompact runtime prompt starts or hands off a compression-planning transaction, or when current work needs details from an active committed midcompact block. Guides candidate discovery, inspect/locate/plan, replacement-summary writing, and recall.
---

# Midcompact

## Route the activation

This skill handles two independent tasks: planning compression and recalling committed content. Choose the route before calling the tool.

| Signal | Immediate duty | First action |
|--------|----------------|--------------|
| Runtime prompt says `FINAL STATE: USER MANUAL` | Let the user create the initial DraftPlan | Reply exactly `OK`; call no midcompact tool |
| Runtime prompt says `FINAL STATE: AGENT DIRECT` | Plan from the new empty draft | `action="inspect"` |
| A handoff reports a persisted DraftPlan and the user asks to continue | Refine the shared draft | `action="plan", op="show"` |
| The user or a projected summary needs detail from a committed block | Retrieve that history only | Follow **Recall workflow** |

The state-specific runtime prompt is authoritative. Recall does not enter planning or mutate the DraftPlan. During the User manual acknowledgement turn, the no-tool instruction overrides every other route.

## Plan compression

Selected ranges become summaries in future model context; content outside them stays verbatim. Originals remain stored, but recall is a recovery path, not a substitute for a sufficient summary. Agent and user edit one DraftPlan; only the user chooses the final depth and runs `/midcompact commit`.

Apply one invariant:

> Every fact that can still affect future work must remain with sufficient fidelity, either outside the selected ranges or in their replacement summaries.

### Planning workflow

#### 1. Inventory and segment

For a fresh Agent-direct transaction, call `action="inspect"`. It returns a bounded, body-free inventory of the frozen anchor, grouped by user message. Page only until the relevant region is covered.

Segment by completed work phase, not message count:

| Usually compress | Keep verbatim or preserve in the summary |
|------------------|------------------------------------------|
| Repetitive or superseded exploration | Current intent and active constraints |
| Tool output absorbed into a conclusion | Exact errors, evidence, or wording whose form matters |
| A completed subtask's intermediate process | Decisions and rationale still governing the work |
| A rejected attempt's mechanics | Its still-relevant failure reason |

Treat `User focus: ...` as scope or depth guidance. Ask only when a remaining choice would materially change what stays visible; otherwise proceed. Inventory counts inform the proposal but are not compression targets.

#### 2. Confirm content and boundaries

Use `action="locate"` for targeted content or boundary checks, not exploratory rereading. Search by a known atom `ref`, text `pattern`, `tool_name`, or source; request `detail="full"` only when needed.

An atom is the smallest selectable unit. A tool call and its matching results form one indivisible `tool_exchange` atom. Keep source text outside a range when exact wording or provenance matters and a summary cannot preserve it equivalently. If you cannot state confidently what a phase established, do not compress it.

#### 3. Build or refine the DraftPlan

A handed-off DraftPlan is the initial proposal. Show it first, preserve valid existing ranges, then refine it as needed.

| Operation | Purpose |
|-----------|---------|
| `plan add` | Add `start`...`end`, preferably with its `summary` and optional `topic` |
| `plan update` | Fill or revise a range's `summary` or `topic` by `draft_id` |
| `plan remove` | Remove a range before replacing its boundaries |
| `plan show` | Inspect the shared draft, pending state, and telemetry |

Use separate ranges for non-contiguous phases. Anything outside a range is KEEP; split around an important atom to leave a KEEP hole. User-created ranges may have pending empty summaries, which require `plan update`. If an operation is rejected or exact parameter behavior matters, read `references/tool-interface.md` before retrying.

#### 4. Write replacement summaries

A replacement summary is successor context for a future Agent, not a transcript or a prompt to perform compression. State the resulting knowledge and working state directly.

Preserve, when applicable:

- user intent and active constraints;
- decisions, conclusions, and necessary rationale;
- relevant files, symbols, interfaces, commands, or configuration;
- completed changes and validation results;
- rejected approaches only when their failure reason still matters;
- unresolved issues and any established next step or continuation state.

Remove repetitive exploration, superseded hypotheses, raw output captured by a conclusion, and chronology with no remaining consequence. Do not turn uncertainty into fact, invent a next action, or use references that only make sense inside the removed text. Keep literal source text outside the range when its wording, structure, or provenance is load-bearing.

Organize by future utility rather than original chronology. When useful, use this compact frame without forcing empty fields:

```text
Goal and constraints:
Established state and decisions:
Artifacts and validation:
Open issues and established next state:
```

Length follows the information that must survive, not a target ratio. Final test: could a fresh Agent continue correctly from this summary plus retained context, without repeating work or violating a prior decision?

#### 5. Verify and hand off

Call `action="plan", op="show"`. Check that the intended phases are covered, KEEP holes remain outside ranges, every range has a summary, and the summaries conserve the future working state. Treat factual content/image measurements and Pi-provided usage as awareness, not unsupported token-savings claims.

Describe the proposal by content and consequence, not only atom IDs. Direct the user to `/midcompact select` or `/midcompact select-webui` for boundaries and KEEP holes, and to `/midcompact review` or `/midcompact review-webui` for summary inspection or rejection. Use the browser variants when the TUI is unavailable or the user prefers them. Ask the user to run `/midcompact commit` when ready; never commit for them.

## Recall compressed content

Recall works with or without an active planning transaction. It reads committed blocks active on the current branch without changing projection or DraftPlan.

### Recall workflow

#### 1. Find the block

If its id is unknown, call `action="recall", pattern="..."` to search active topics and summaries. A projected summary also states its block id and exact recall call.

#### 2. Retrieve the detail

Call `action="recall", ref="c0001"`. If the readable, structure-flattened result ends with a truncation marker, retry with `detail="full"`. Retrieve only what the current task needs; do not start or change a plan merely to recall history.

## Tool conventions

- `g0001` labels an inventory group; use its `a...` span as landmarks.
- `a0001` is an atom ref local to the current transaction; never reuse it after commit.
- `d1` is a DraftPlan range id for update/remove; `c0001` is an active committed-block id for recall.
- Protected atoms cannot enter a range. Split around them.

Read `references/tool-interface.md` for exact defaults and limits, rejected operations, protected-atom causes, telemetry, repeated compression, or recall truncation.
