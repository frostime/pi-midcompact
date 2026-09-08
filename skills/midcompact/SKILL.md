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

Keep important user goals, constraints, preferences, corrections, authorizations, and refusals verbatim by default. Summaries can alter their scope or force. Ask for explicit agreement before summarizing them; general permission for aggressive compression is insufficient.

Ask Question, questionnaire, and similar tool results may contain user expression. Judge by the speaker, not entry type. Retain the whole indivisible tool-exchange atom containing an important answer; split around it.

Routine acknowledgements can be candidates; task completion alone does not invalidate important statements.

### Propose and stop

Use conversation landmarks to explain replacements, originals kept, and summary contents. Offer alternatives for meaningful tradeoffs, not every delegated choice.

Stop when the goal is reasonably served or further compression is not worth the loss, not when all eligible content is covered. Re-align if findings materially change the treatment.

## Write a local replacement

Summaries belong between retained earlier and later context, not as compression instructions or standalone handoffs.

Preserve necessary causes, consequential actions and findings, and resulting knowledge. Name important files, symbols, commands, or artifacts with their roles. Distinguish proposals from changes and assumptions from observed results. Length follows information needs, not a fixed ratio.

Preserve consequential process, not activity logs. Replace vague “files changed, tests passed” with specific evidence: “Compared caller and parser, found ignored boundary arguments, added rejection, and verified an invalid-argument test.” Include relevant paths and results from the source.

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
- **Replacement:** Mentally remove the originals. Do summaries plus retained context explain the necessary causes, actions, evidence, and outcomes without gaps, vague claims, stale instructions, or state conflicts?

Report replacements, retained originals, and stopping rationale. Boundaries: `/midcompact:select` or `/midcompact:select-webui`. Summaries: `/midcompact:review` or `/midcompact:review-webui`. Prefer browser variants when TUI is unavailable or unwanted. Only the user runs `/midcompact:commit`.

## Recall

Recall reads active committed blocks without changing a plan and needs no transaction. If the id is unknown, use `request={action:"recall_list",pattern:"..."}` to search ids, topics, and summaries, not originals. Projected summaries carry block ids and recall calls.

Use `request={action:"recall_read",block:"c0001"}`; retry truncation with `detail:"full"`. If still truncated, read `references/tool-interface.md`. Retrieve only needed content.

`a...` refs are transaction-local; `d...` identifies a plan range; `c...` a committed block. Inventory `g...` labels are display-only; use listed atom refs for calls.
