# Context Inventory Selection Prototype Handover

## Purpose

This document hands the current `context-inventory-selection` work to a later agent after context reduction. It covers the unified DraftPlan behavior and the current static UI prototype. The prototype is exploratory and is not the final product design.

## Source Of Truth

Use the following files in this order:

1. `.dev/context-inventory-selection/context-inventory-selection.SPEC.md` for the current product behavior contract.
2. `src/` and `test/` for the current implementation and executable behavior.
3. `.dev/context-inventory-selection/context-inventory-selection-prototype.html` for the current visual prototype only.
4. `.dev/context-inventory-selection/deprecated/` contains historical LAND/PLAN files and is not an implementation source.

The core implementation checkpoint is commit `3432096` (`feat(midcompact): unify draft planning workflow`). The prototype file is a development artifact and may be uncommitted.

## Product Model

User and Agent operate one shared `DraftPlan`.

```text
Agent tool endpoint  ─┐
                      ├─ shared DraftPlan mutation and validation
User UI endpoint     ─┘
```

A `DraftRange` may have an empty `summary`; this means pending summary. Review may display pending ranges, but commit requires every range to have a non-empty summary. Only the user can commit. Agent may add, update, remove, or summarize ranges before the user commits.

Selection is a user interaction surface, not a separate persisted domain object. Selection normalization still converts user atom choices into ordinary ranges and removes protected/KEEP holes. Tool exchanges remain indivisible.

## Entry Behavior

The user command remains:

```text
/midcompact start [instructions]
```

The entry decision has three outcomes:

- `Drop`: cancel the start without creating a transaction;
- `Agent direct`: freeze the anchor and start the Agent workflow;
- `User manual`: freeze the anchor and open the Selection surface.

The static prototype shows these as three choices on `?view=start`. This is a prototype representation of the behavior; the final terminal control may use a different control.

## Agent Handoff

User-first does not automatically start a model turn. Saving the user DraftPlan and closing the editor only persists the plan.

When a later user message starts an Agent turn while a midcompact transaction is active, the Agent must be given a short internal handoff context. The context tells the Agent:

- an active midcompact DraftPlan exists;
- the DraftPlan may contain user-created ranges;
- if the user is asking to continue midcompact, call `plan show` first;
- treat the existing plan as the initial proposal and continue from it.

This handoff context must not automatically trigger an Agent turn. The runtime implementation still needs a `before_agent_start`-style injection and an end-to-end test for:

```text
User edits DraftPlan → saves → sends a later user message → Agent first calls plan show
```

## Runtime Mutual Exclusion

The planning lock is runtime-only. It is not part of transaction persistence and is not restored after reload.

Required behavior:

- Agent turn start acquires the Agent runtime lock;
- `agent_settled` releases it;
- an Agent turn cannot operate on the active DraftPlan while a user editor holds the UI lock;
- a user editor cannot open while an Agent turn holds the Agent lock;
- commit and abort are rejected while an Agent turn is processing;
- UI close or disconnect releases the UI lock;
- reload clears the runtime lock; the next operation acquires a new lock.

The lock prevents concurrent operation; it does not record history or ownership after the operation ends.

## UI Relationship

Selection and Review are separate views over the same DraftPlan and the same anchor timeline. They should share the main workbench structure and differ mainly by available operations.

### Selection

Selection is responsible for:

- choosing groups or atoms;
- adding and removing ranges;
- setting KEEP choices;
- showing protected atoms and tool exchanges;
- saving the initial DraftPlan.

### Review

Review is responsible for:

- browsing the current DraftPlan;
- folding and unfolding timeline groups;
- selecting a range and locating its atoms;
- viewing atom previews;
- editing summary text;
- deleting a range when the user rejects it;
- committing only when all summaries are complete.

Review does not create, resize, or re-segment ranges. Range creation and boundary changes belong to Selection. Deleting a range remains available in Review as a rejection operation.

## Current Prototype

File:

```text
.dev/context-inventory-selection/context-inventory-selection-prototype.html
```

Query views currently included:

```text
?view=start
?view=selection
?view=review
```

The prototype uses static mock data and client-side state. It is intended to compare information hierarchy and interaction shape, not to validate transport, persistence, or final copy.

The current prototype deliberately demonstrates:

- a three-choice start page;
- a shared three-pane workbench for Selection and Review;
- left DraftRange list;
- center collapsible anchor timeline;
- clickable range selection and timeline location;
- visible cell preview content;
- Tool name badges for `read`, `write`, `edit`, and `bash`;
- Selection controls for group add, atom add/remove, and KEEP;
- Review summary editor and range removal;
- pending summary badges and disabled commit state;
- explicit save;
- Save & close / Discard / Stay when closing with dirty changes;
- larger text and Chinese-compatible font fallbacks, including HarmonyOS Sans.

## Prototype Non-Goals

The following omissions in the static prototype are intentional simplifications and must not be interpreted as final product decisions:

- The original top progress/usage bar was simplified. It must not be removed from the final Review UI merely because it is absent from this prototype.
- Existing Pi-reported usage presentation and future replacement metrics need a deliberate final design.
- Keyboard shortcuts, help, refresh, search/filter behavior, Save all, theme controls, and detailed responsive behavior are not fully represented.
- Server routes, API serialization, lock wiring, and real session persistence are not represented.
- Handoff and lock states are not shown as prototype pages because they are not useful for the current visual comparison; their runtime behavior remains part of the product contract.
- The prototype's mock data and labels are illustrative only.

When adapting the prototype to production, start from the existing `src/review-webui.html` behavior and preserve useful interactions incrementally. Do not replace the existing Review workbench wholesale merely to match the simplified prototype.

## Next Work

1. Implement the confirmed Agent handoff context injection and add the end-to-end test.
2. Review the static prototype with the user for information hierarchy and operation placement.
3. Integrate Selection as a parallel view using the existing Review workbench structure.
4. Preserve the existing Review interactions, including progress/usage presentation, folding, atom preview, range navigation, and deletion, while applying the confirmed operation boundaries.
5. Replace legacy local token claims with the approved Pi-reported and chars/images presentation where the final UI requires it.
6. Only after the prototype is accepted, implement production TUI/Web UI changes.

Do not treat the prototype's simplified page contents as a deletion request. Treat it as a focused sketch of the shared workbench and the difference between Selection operations and Review operations.
