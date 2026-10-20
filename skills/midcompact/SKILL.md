---
name: midcompact
description: "Use when runtime starts or hands off midcompact planning, or current work needs originals from a committed block. Guides selective compression, local summaries, and recall."
---

# Midcompact

The frozen **anchor** contains **atoms** (`a0001`), the smallest selectable units; tool calls and their results stay together. Agent and user share one **plan** of contiguous **ranges** (`d1`) and replacement summaries. Human commit turns ranges into **blocks** (`c0001`) that replace their originals in future context. **Recall** retrieves the originals.

Read `references/tool-interface.md` when composing calls or handling protection, truncation, or a stuck WebUI. Use the schema for fields and defaults.

## Route the activation

Runtime instructions take precedence.

| Signal | Action |
|---|---|
| Runtime says `FINAL STATE: USER MANUAL` | Reply exactly `OK` and stop. Ask nothing and call no midcompact tool; wait for the user's later request. |
| Runtime says `FINAL STATE: AGENT DIRECT` | Call `request={action:"inspect"}` first, then establish the direction. |
| A persisted plan exists and the user asks to continue | Call `request={action:"plan_show"}` first, then establish the direction. |
| Current work needs originals from a committed block | Go to **Recall**. Do not establish a direction or plan. |

## Establish the direction

Follow the user's stated direction or delegation. Otherwise, ask before selecting ranges or investigating deeply:

> Do you want light cleanup or substantial room for what comes next? What should I focus on, and what must stay verbatim? You can give a target usage or delegate the choice.

For an existing plan, infer whether to refine, extend, or only fill summaries; ask if the scope is materially ambiguous. Once direction is set, edit the plan directly. Re-align before changing direction or scope, or sacrificing important information to meet a target. Compare factual character/image measurements; do not promise exact post-commit token savings.

## Select ranges

Replace only content whose compression serves the direction. Stop when the goal is reasonably met or further compression is not worth the information lost; covering all eligible history is not a goal.

Ground candidates in visible conversation or `locate_ref`/`locate_search`, not `inspect` landmarks alone. Use targeted lookups for missing content or unclear boundaries only when they could change selection. Drop uncertain candidates or ask if investigation would exceed the agreed effort. Use `measure` when relative size affects selection.

- Replace repetitive execution when results suffice. Retain useful request/conclusion text; summarize necessary findings absent from it.
- Replace superseded discussion and detours. Retain rejection reasons that explain decisions or prevent repeated mistakes.

Choose boundaries by content, not turn count. Split around important originals or where parts need different detail. Check that separate ranges neither duplicate information nor break causal links.

### Keep important user expression

Keep whole atoms containing important user goals, constraints, preferences, corrections, authorizations, or refusals outside ranges by default. This includes answers inside Ask Question or similar tool exchanges: judge by speaker, not entry type. Routine acknowledgements can be compressed; completed work does not make its instructions unimportant.

Compress important user expression only with explicit consent for that expression, not general permission for aggressive compression. Then quote important instructions exactly, with speaker, conditions, negations, exceptions, and scope intact. Copy from fully visible source text; look up truncated originals, never reconstruct quotes from memory. Do not repeat instructions retained outside the range.

## Write the replacement

Write a local historical replacement, not a standalone handoff or new instructions for future work. Use all four headings, in order, for every replacement:

```markdown
### Goal / Topic
State the concrete goal, question, or information topic and necessary source-grounded background.
### Actions / Findings / Outcome
State consequential actions, findings, reasons, and observed results with evidence.
### Important references
- User instructions: Include authorized exact quotes with the speaker, or note that relevant instructions remain outside the range; otherwise N/A.
- Files / Symbols / Commands / Artifacts: Name the references that matter, each with its role or observed result.
### Constraints / Context
State applicable limits, dependencies, and historical context needed by retained surroundings.
```

- Use `N/A` for inapplicable sections/items, never unknown facts. Look up necessary unknowns; narrow the candidate or ask if they exceed the agreed effort.
- State facts, not your evaluations ("excellent solution", "successfully fixed"). Preserve consequential source judgments with attribution.
- Distinguish proposed, attempted, changed, and verified; label assumptions.
- Prefer accurate excerpts when wording affects decisions or behavior. Length follows information needs, not a fixed ratio.

The automatic **file activity** appendix lists structured read/write/edit paths, not verified outcomes; it omits Bash and unrecorded nested calls. Do not reproduce the list. Explain important references and observed results, including those absent from the appendix, without listing every touched file.

Illustrative wording (not a complete replacement):
- **Bad:** "Improved validation; tests passed. Next: deploy."
- **Good:** "Because `parseArgs` ignored unknown flags, added rejection in `src/args.ts`. `npm test -- args` reported 3 passing tests. Deployment was proposed, not performed." Use such wording only when the source contains those facts.

### Fit the retained surroundings

Read enough surrounding retained context to avoid duplication, preserve its dependencies, and resolve dangling references. Recall is recovery, not a substitute for sufficient summaries.

A range's end is historical, not automatically current. Omit unfinished status resolved later, unless it explains later events; then label it as historical. Do not attribute later results to this range. Include current open issues or established next steps only when the range reaches the current working frontier and continuation needs them.

If later retained turns reject approach A, "Next: validate A" is stale. Preserve why A was proposed only if needed to explain the rejection.

## Build, check, and hand off

Use `plan_add`, `plan_update`, and `plan_remove`; updates change summary/topic, boundary changes require remove + add. Split around protected atoms.

Before handoff:

- Check each quote, load-bearing excerpt, and evidence claim against its source.
- Confirm all four headings and both reference subitems are present in every replacement; use `N/A` only where inapplicable.
- Review the projected context—retained content plus all replacements—as if the originals were gone. Check for missing dependencies, duplication, and stale task status.
- Call `plan_show` to confirm the ranges fit the direction, contain no important user atom without authorization, and have no pending summary. Use `plan_read` where a stored summary needs full review.

Report replacements, retained originals, and stopping rationale using conversation landmarks. Offer alternatives for meaningful tradeoffs. Boundaries: `/midcompact:select [tui|webui]`; summaries: `/midcompact:review [tui|webui]`. Without an argument, let the user choose the surface. Only the user runs `/midcompact:commit`.

If a WebUI planning lock still blocks you after the browser is closed, ask the user to run `/midcompact:close-webui` (see the reference). No tool action bypasses the lock.

## Recall

Recall needs no transaction and changes no plan. Projected summaries carry block ids. If unknown, use `request={action:"recall_list",pattern:"..."}` to search ids, topics, summaries, and file activity, not originals.

Read with `request={action:"recall_read",block:"c0001"}`. If truncated, retry with `detail:"full"`. If still truncated, report that the omitted evidence is unavailable; do not infer it.

`a...` refs are transaction-local; `d...` is a range id and `c...` a block id. Inventory `g...` labels are display-only; use the listed `a...` refs in calls.
