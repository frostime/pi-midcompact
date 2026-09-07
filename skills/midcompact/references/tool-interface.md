# Midcompact Tool Interface

Read this reference when exact call requirements, limits, rejection behavior, repeated compression, or recall truncation matters. The main workflow remains in `../SKILL.md`.

## Parameter grouping

The parameters are one object with a single `request` field; `request` is a union of single-purpose actions where each branch binds one `action` value to exactly that action's fields and is closed (`additionalProperties: false`). A call that carries a field outside the selected action is rejected; re-issue the call with only the selected action's parameters. The actions:

`inspect` · `measure` · `locate_ref` · `locate_search` · `plan_show` · `plan_read` · `plan_add` · `plan_update` · `plan_remove` · `recall_list` · `recall_read`

## Inspect

`request.action="inspect"` inventories the frozen anchor. It returns factual structure and bounded user landmarks, not full message bodies, assistant/tool previews, summaries, or image base64.

- `page_size`: default 20 groups, maximum 50; out-of-range values are clamped.
- `cursor`: opaque value returned by the previous page.
- Results include group refs, atom spans, content chars, image facts, protected/compressible counts, and Pi-reported anchor usage.

Stop paging after the candidate regions are covered. Group labels (`g0001`) are display-only; they are not atom refs.

## Measure

To compare explicit candidates without mutating the plan, pass one or more possibly overlapping spans:

```text
midcompact(request={action:"measure", candidates=[
  {"start":"a0006","end":"a0014"},
  {"start":"a0006","end":"a0020"}
]})
```

Measurement reports bounded endpoint landmarks, atom/message and role counts, tool exchanges and calls, factual content share, images, and protected/compressible counts. It has a 12,000-character total output budget and reports how many requested spans fit. It does not report per-span tokens: Pi supplies usage for the whole anchor, not token attribution by range. `candidates` requires at least one span.

## Locate

Two actions read atoms from the frozen anchor.

`request.action="locate_ref"` looks up one atom by `ref` (for example `a0007`). With `detail="full"` it preserves both ends with an explicit middle-omission marker when the 12,000-character atom limit is exceeded; brief output shows a bounded preview. An unknown ref returns no match: re-run inspect/measure against the current transaction snapshot. A `g...` group label is not a locate ref; use the group's `a...` landmarks.

`request.action="locate_search"` filters atoms conjunctively (AND). Supply at least one of:

- `pattern`: case-insensitive substring over atom text;
- `tool_name`: exact (case-insensitive) originating tool name;
- `source`: `user`, `assistant`, `tool_call`, or `tool_result`.

There is no `any` value; omit `source` instead. Matches are capped at three with bounded excerpts around the match; `direction` orders `oldest` (default) or `newest`, and `limit` may request one to three results. When more atoms match, the result reports the total and asks for a more specific pattern or an additional filter. Search has no `detail` option; use `locate_ref` for full atom text.

## Plan

Agent and user mutate the same plan. Read actions:

- `request.action="plan_show"` — brief list of every range (bounded `from`, `to`, and `summary` landmarks plus factual metrics) under a 12,000-character budget. Takes no fields.
- `request.action="plan_read"` — one range's stored summary and endpoint previews in full, under a 40,000-character budget. Requires `range_id`.

Mutations:

| action | Required fields | Optional fields |
|--------|-----------------|-----------------|
| `plan_add` | `start`, `end` | `summary`, `topic` |
| `plan_update` | `range_id` and at least one of `summary`, `topic` | — |
| `plan_remove` | `range_id` | — |

An omitted or empty `summary` creates a pending range. Review can open it, but commit requires at least one range and a non-empty summary for every range. Boundaries are immutable: changing them means `plan_remove` plus `plan_add`. Show and read are read-only and do not persist duplicate entries.

Add rejection conditions:

| Condition | Response |
|-----------|----------|
| The range crosses a protected atom | Split the range around that atom |
| The range overlaps an existing plan range | Remove or replace the existing range first |
| `start` occurs after `end` | Correct the positional order |
| An atom ref is unknown | Re-run inspect/measure against the current transaction snapshot |

An atom is protected when its tool protocol is incomplete or orphaned, it represents an existing compressed block, its message kind is unsupported, or it lacks the persistent session entry needed to anchor compression.

Mutation responses omit the Pi-awareness header and unchanged ranges, returning only the changed range (or the removed id plus compact totals). Use explicit show/read when complete awareness is needed.

## Telemetry

`plan_show` and `plan_read` include Pi-reported anchor usage when available and factual draft measurements: original/replacement content chars, image count, and decoded payload bytes. Mutation results omit awareness and report only compact totals plus the changed range where one remains. Local character or image measurements are not converted into token savings or projected-token percentages. Use measurements to compare the proposal with user-directed depth, not as an optimization target.

## Repeated compression

Committed blocks appear as protected atoms in later transaction snapshots and cannot be compressed again. A later transaction may compress newly accumulated raw history around those blocks. Re-run inspect/measure because atom refs are transaction-local.

## Recall

Recall actions work independently of a planning transaction and read committed blocks active on the current branch.

`request.action="recall_list"` lists blocks. Without `pattern` it lists the most recent blocks; with `pattern` it matches block id, topic, and summary — not original content. `limit` defaults to 8 with a maximum of 20; out-of-range values are clamped.

`request.action="recall_read"` renders one block's stored messages. It requires `block` (for example `c0001`). `detail="full"` raises the rendering cap when the normal result is truncated.

Recall has no paging. The truncation marker is `[truncated; refine the recall request or inspect the source session for more]`. If `detail="full"` still truncates before the needed detail, report that recall cannot expose the omitted content; do not infer it.
