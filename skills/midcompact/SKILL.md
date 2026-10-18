---
name: midcompact
description: "Use when runtime starts or hands off midcompact planning, or current work needs originals from a committed block. Guides selective compression, local summaries, and recall."
---

# Midcompact

The frozen **anchor** contains **atoms**, the smallest selectable units (ref `a0001`); tool calls and their results stay together. Agent and user share one **plan** of contiguous **ranges** with replacement summaries (id `d1`). **Measure** compares candidates without changing the plan. Human commit turns each range into a **block** (`c0001`), replacing its originals in future context. **Recall** retrieves those originals.

## Route the activation

| Signal | Immediate action |
|---|---|
| Runtime says `FINAL STATE: USER MANUAL` | Reply exactly `OK`; call no midcompact tool. |
| Runtime says `FINAL STATE: AGENT DIRECT` | Call `request={action:"inspect"}`. |
| Handoff reports a persisted plan and user asks to continue | Call `request={action:"plan_show"}` before other midcompact actions. |
| Current work needs originals from a committed block | Follow **Recall**; do not enter planning. |

Runtime instructions are authoritative. User-manual acknowledgement also forbids questions. Otherwise, complete the required first action before establishing direction.

Read `references/tool-interface.md` when composing calls or handling protection/truncation. Use the schema for fields and defaults.

## Establish the compression direction

If the user has not expressed a compression preference, ask before selecting ranges or investigating deeply:

> Do you want light cleanup or substantial room for what comes next? What should I focus on, and what must stay verbatim? You can give a target usage or delegate the choice.

Honor existing preferences; otherwise accept qualitative goals or delegation. Clarify ambiguous handoffs: refine the selection or work only within it? Respect explicit scope limits.

Match compression and investigation effort to that direction. Compare factual character/image measurements; do not promise exact post-commit token savings. If meeting a target requires sacrificing important information, explain the tradeoff.

## Select worthwhile ranges

Keep originals unless replacement serves the agreed goal; full-history coverage is not success.

Use `inspect` for structure and volume, not to infer unseen content. Ground candidates in visible conversation or targeted `locate_ref`/`locate_search` calls. Investigate only what could change selection; omit uncertain candidates or ask if investigation exceeds the agreed effort. Use `measure` when relative sizes affect the choice.

Weigh bulk removed against original detail lost and what retained context already carries. Technical eligibility alone does not justify compression.

### Common patterns

These are examples, not fixed rules about message roles or age.

- **Long execution between user messages.** Replace repetitive search, reading, editing, and testing when only results matter. Retain useful request/conclusion text and summarize key findings absent from it; tool output is not automatically noise.
- **Multi-turn discussion.** Summarize superseded proposals, repeated clarification, and detours. Keep failure reasons that explain decisions or prevent repeated mistakes; age alone does not make discussion obsolete.

One range reduces repetition in coherent discussion but may flatten distinctions. Semantic ranges allow different detail levels and KEEP holes, but risk duplication or broken causal links. Choose by content, not turn count; split around important originals.

### Preserve important user expression

Keep the whole original atom containing important user goals, constraints, preferences, corrections, authorizations, or refusals by default; split ranges around it. Ask for explicit consent to compress that expression; general permission for aggressive compression is insufficient.

If compression is authorized, quote important instructions exactly from the source and identify the speaker. Preserve their conditions, negations, exceptions, and scope. Never reconstruct quotes from memory or duplicate instructions already retained outside the range.

Ask Question, questionnaire, and similar tool results may contain user expression. Judge by the speaker, not entry type. Keep their whole indivisible tool-exchange atom unless this compression is explicitly authorized.

Routine acknowledgements can be candidates; task completion alone does not invalidate important statements.

### Propose and stop

Use conversation landmarks to explain replacements, originals kept, and summary contents. Offer alternatives for meaningful tradeoffs, not every delegated choice.

Stop when the goal is reasonably served or further compression is not worth the loss, not when all eligible content is covered. Re-align if findings materially change the treatment.

## Write a local replacement

Summaries belong between retained earlier and later context, not as compression instructions or standalone handoffs.

Use these four headings in every replacement, in this order. Fill them with concrete source facts, not generic summaries. Use `N/A` only when genuinely inapplicable, not when facts are unknown.

```markdown
### Goal / Topic
State the concrete goal, question, or information topic and necessary source-grounded background.
### Actions / Findings / Outcome
State consequential actions, findings, reasons, and observed results with evidence.
### Important references
- User instructions: Include authorized exact quotes with the speaker, or note that relevant instructions remain outside the range; otherwise N/A.
- Files / Symbols / Commands / Artifacts: Name relevant references and explain their roles.
### Constraints / Context
State applicable limits, dependencies, and historical context needed by retained surroundings.
```

Describe facts neutrally, without evaluations such as “excellent solution” or “successfully fixed.” Distinguish proposals, attempted actions, completed changes, and verified outcomes; label assumptions as assumptions. Prefer accurate source excerpts over paraphrasing facts whose wording affects decisions or behavior. Never invent missing facts; use targeted lookups for unseen facts needed by the replacement. Length follows information needs, not a fixed ratio.

The code supplies a separate **file activity** index: paths from read calls and write/edit calls. It records historical attempts, not success; it neither infers activity from bash nor provides a complete audit. Do not manually reproduce the index. Still supply each consequential action's purpose and observed result, with relevant references and evidence.

Illustrative wording (not a complete replacement):
- **Bad:** “Improved validation; tests passed. Next: deploy.”
- **Good:** “Because `parseArgs` ignored unknown flags, added rejection in `src/args.ts`. `npm test -- args` reported 3 passing tests. Deployment was proposed, not performed.” Use this wording only if those facts appear in the source.

### Fit the retained surroundings

Read enough surrounding context to avoid duplication and preserve what it depends on from this range. Resolve dangling references without inventing facts. Recall is recovery, not a substitute for sufficient summaries.

A range's end is a historical boundary, not automatically the present state:

- Do not turn an old unfinished task into a current TODO. Omit it if later retained context resolves it and its earlier status adds nothing.
- If the earlier status explains later events, describe it as historical. Do not attribute a later result to work within this range.
- Include current open issues and established next steps only when the range reaches the current working frontier and continuation needs them. Never invent a next action.

If later retained turns test and reject approach A, “Next: validate A” is stale. Preserve why A was proposed if needed to explain the rejection; leave later outcomes where they belong.

## Build, check, and hand off

Resolve boundaries with targeted lookups; split around protected atoms. Use `plan_add`, `plan_update`, and `plan_remove`. Updates change summary/topic; boundaries require remove + add. Fill pending summaries before handoff.

Call `plan_show`; use `plan_read` when a stored summary needs full review. Check both:

- **Selection:** Does each range serve the user's direction? Are important originals and intended KEEP holes retained? Has unnecessary full-history coverage crept in?
- **Replacement:** Mentally remove the originals and check:
  - Are all four headings and both reference subitems present, with concrete facts or `N/A` only where genuinely inapplicable?
  - Do retained context and replacements explain necessary reasons, actions, references, evidence, and outcomes without vague evaluations or gaps? Are load-bearing excerpts accurate and unseen facts looked up rather than invented?
  - Are important user atoms kept whole unless explicitly authorized for compression? Are authorized quotes source-exact, attributed, complete in scope, and not duplicated from retained context?
  - Are proposals, attempts, changes, assumptions, and verified results distinct? Does each historical boundary remain historical, without stale TODOs, later outcomes imported into the range, or standalone-handoff instructions?
  - Does the replacement supply purposes and results without reproducing the code-owned file activity index or treating it as proof of success or a complete audit?

Report replacements, retained originals, and stopping rationale. Boundaries: `/midcompact:select [tui|webui]`. Summaries: `/midcompact:review [tui|webui]`. Without an argument, the user chooses a surface; do not choose one for them. Only the user runs `/midcompact:commit`.

If the Agent remains blocked by a WebUI planning lock after the browser is closed, ask the user to run `/midcompact:close-webui`. It closes Selection/Review WebUI without changing the saved plan or transaction. Unsaved browser edits are not saved. It does not release an Agent-held lock; there is no tool action to bypass the lock.

## Recall

Recall reads active committed blocks without changing a plan and needs no transaction. If the id is unknown, use `request={action:"recall_list",pattern:"..."}` to search ids, topics, summaries, and file activity, not originals. Projected summaries carry block ids and recall calls.

Use `request={action:"recall_read",block:"c0001"}`; retry truncation with `detail:"full"`. If still truncated, read `references/tool-interface.md`. Retrieve only needed content.

`a...` refs are transaction-local; `d...` identifies a plan range; `c...` a committed block. Inventory `g...` labels are display-only; use listed atom refs for calls.
