# Tool Call Patterns

Use the schema for fields/defaults. Follow only the steps needed. Example refs and summaries must be replaced with verified content.

## Survey where context space goes

Start a fresh Agent-direct transaction with:

```json
{"request":{"action":"inspect"}}
```

Read overall Pi token usage and chronological groups: user landmarks, endpoints, characters, images, protection counts. This paginated volume distribution is not a per-group token curve. Large groups invite investigation, not automatic compression.

Continue with the returned `cursor` only where relevant. Use listed `a...` refs, not display-only `g...` labels. Landmarks are not full content; combine the overview with user preferences before selection.

## Find evidence and check boundaries

For a recent bash result containing a known phrase:

```json
{"request":{"action":"locate_search","source":"tool_result","tool_name":"bash","pattern":"timeout","direction":"newest"}}
```

Filters combine with AND. Use a returned atom ref to inspect the match:

```json
{"request":{"action":"locate_ref","ref":"a0007","detail":"full"}}
```

Known refs need no search. Excerpts are incomplete; `full` can omit the middle. Check markers before drawing conclusions. Narrow excessive matches with filters. Recover unknown refs using `inspect` or `locate_search`; `measure` needs known refs.

## Compare candidates without changing the plan

```json
{"request":{"action":"measure","candidates":[{"start":"a0006","end":"a0014"},{"start":"a0006","end":"a0020"}]}}
```

Candidates may overlap without changing the plan. Compare landmarks, content share, images, and protection, not assumed token savings. If fewer candidates are reported than requested, measure the remainder separately.

## Keep important originals between ranges

If an important user answer occupies `a0010`, locate it and verify boundaries, then add separate ranges on its two sides:

```json
{"request":{"action":"plan_add","start":"a0006","end":"a0009","summary":"<replacement for the earlier work>"}}
{"request":{"action":"plan_add","start":"a0011","end":"a0014","summary":"<replacement for the later work>"}}
```

Question-tool answers are user expression. Keep the whole tool-exchange atom containing an important answer; do not split a call from its results. Unlike measurement candidates, plan ranges cannot overlap or contain protected atoms.

## Refine an existing plan

Start with `plan_show`. Use `plan_read` with its returned `range_id` when the stored summary or endpoints need full review. Change summary/topic with `plan_update`.

For new boundaries, first read and retain the existing summary/topic and verify the replacement endpoints. Then `plan_remove` the old range and `plan_add` its replacement. Do not assume the new id is unchanged. Check the resulting plan; mutation replies show the changed item and compact totals, not all ranges. Fill pending summaries before handoff; only the user commits.

## Work around protected content

Split around protected atoms. Causes include ambiguous tool protocol (nonlocal, duplicate, or non-unique call/result relationships), orphan results, unsupported message kinds, missing persistent entries, and existing committed blocks. An abandoned exchange has a frozen tool call with no result anywhere in the anchor and can be compressed as a whole. Later transactions can compress remaining raw history around committed blocks, not recompress the blocks themselves. Obtain current atom refs from `inspect`; refs are transaction-local.

## Retrieve committed evidence

```json
{"request":{"action":"recall_list","pattern":"timeout"}}
{"request":{"action":"recall_read","block":"c0001"}}
```

Use the actual block id returned by the list; skip listing when known. Listing searches ids/topics/summaries, not originals. Recall needs no transaction. If truncated, retry the same block with `detail:"full"`. There is no paging: if still truncated, report that recall cannot expose the omitted evidence. Do not infer it or start another transaction as a recovery workaround. Inspecting the source session requires a separate available means; this tool offers none.
