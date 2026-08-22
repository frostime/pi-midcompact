# Midcompact Agent-Output Efficiency Follow-up

## Scope and goal

This follow-up comes from one live User-manual transaction plus source review. It targets the cost and reliability of planning inside Midcompact's isolated Pi branch:

- reduce unnecessary Agent turns and tool round trips;
- keep individual tool results bounded when the inherited anchor is already near the model context limit;
- let the Agent understand and compare candidates before mutating the shared DraftPlan.

Planning output does not reduce the context reclaimed on the main branch. The risk is local to the isolated planning branch: user quota/time can be wasted, and an overlong planning process can exhaust the remaining context before commit.

## Observed gaps

### Shared-plan handoff

Default `plan show` exposed refs, status, and measurements but omitted the stored summary and endpoint previews. A handed-off Agent therefore could not understand a summarized user-created range at all; for a pending range it needed separate `locate` calls for each endpoint.

The runtime handoff also called every existing manual plan an `initial proposal`, although a user selection may be either exact or open to refinement.

### Mutation output

Every `plan add/update/remove` returned telemetry and every range, while omitting the changed summary. Repeated mutations therefore re-rendered unchanged state. Read-only `plan show` also persisted a duplicate DraftPlan entry.

### Locate behavior

Filtered locate queries allowed up to 20 results. Brief output always showed an atom prefix, even when a pattern matched in the omitted middle. Full detail could return up to 20 atoms at 12,000 characters each.

### Candidate measurement

Inventory exposed factual metrics per user-led group, but no read-only operation measured arbitrary candidate spans. Exact range metrics became available only after `plan add`, encouraging mutation merely to compare scope. Overlapping conservative/balanced/deep candidates could not coexist in the DraftPlan for comparison.

### Landmark truncation

Inventory labels and atom previews kept only the prefix. Long messages often carry identifying constraints or conclusions at the end, so prefix-only landmarks can make distinct messages hard to recognize.

## Agreed tool contract

### Plan show and mutations

Default `action="plan", op="show"` lists every range within a total output budget and includes:

- id, refs, topic, and pending/summarized status;
- bounded `from` and `to` landmarks;
- a bounded stored summary or `<pending>`;
- factual content/image measurements.

`action="plan", op="show", detail="full", draft_id="d1"` returns one range under a 40,000-character total budget. Full detail without `draft_id` is rejected.

Show is read-only and does not append a duplicate DraftPlan entry. Add/update return only compact totals plus the changed range; remove returns compact totals and the removed id. Mutation output omits repeated Pi-awareness data and unchanged ranges.

The runtime describes a persisted selection as the `current shared draft` and asks the Agent to infer whether the user wants it preserved, refined, or extended.

### Locate

Locate is a targeted disambiguation tool, not an inventory browser.

- Direct `ref` lookup returns one atom.
- Filtered searches return at most three brief candidates.
- If more atoms match, the output reports the total and asks for a narrower pattern/filter.
- Pattern output is centered on the matched text.
- `detail="full"` requires one direct `ref`.
- Oversized direct content preserves both ends and marks the omitted middle explicitly.

The three-result bound applies to ambiguous search results. It does not apply to explicitly supplied inspect spans.

### Inspect inventory and spans

Inventory keeps its existing user-led groups and factual metrics. Its note states honestly that it includes bounded user landmarks but no full bodies or assistant/tool previews.

`action="inspect", spans=[...]` measures explicit, possibly overlapping candidates without changing the DraftPlan. It reports:

- bounded endpoint landmarks;
- atom and message counts with role distribution;
- tool-exchange and tool-call counts plus tool names;
- factual content characters and share of anchor factual content;
- image count, MIME types, and payload bytes;
- compressible/protected counts and protected refs.

Span inspection is bounded by a total response-character budget rather than an arbitrary number of spans. It returns as many complete span blocks as fit and reports how many remain. Pagination arguments cannot be combined with spans.

No per-span token count is reported. Pi provides usage for the whole anchor, while the repository's legacy `approxTokens` is only a character heuristic and is not authoritative token attribution.

### Landmark policy

Use different bounded rendering according to purpose:

| Purpose | Rendering |
|---------|-----------|
| Message/range identity | prefix + explicit middle omission + suffix |
| Pattern search | excerpt around the match |
| Oversized direct/full content | prefix + omitted-character count + suffix |

This policy applies to inventory user labels, atom previews, plan endpoints, and inspect-span endpoints. It does not change semantic selection or persistence.

## Out of scope / not planned

The following ideas were considered during review but are not required by this change and are not planned work:
- The User-manual acknowledgement-only Agent turn remains unchanged; changing its lifecycle was not part of this work.
- No multi-ref locate or new top-level tool action is added.
- No automatic classification of which tool results contain user-originated answers is added.
- No tokenizer or local token-savings projection is introduced.
- Additional semantic landmarks in the inventory require separate evidence and a separate decision.

## Acceptance checks

- One default `plan show` makes a persisted range understandable without endpoint `locate` calls.
- A user-authored summary is visible to the handed-off Agent; pending ranges show `<pending>`.
- Plan mutations confirm the changed state without repeating awareness or unchanged ranges.
- Read-only show does not append persisted draft state.
- Filtered locate returns at most three candidates and exposes the match text.
- Full locate without direct `ref` is rejected.
- Inspect can compare overlapping spans without DraftPlan mutation and remains within its output budget.
- Long landmarks visibly preserve both their beginning and end.
- A new User-manual live test records Agent turns, Midcompact calls, cumulative tool-result characters, and largest single result.
