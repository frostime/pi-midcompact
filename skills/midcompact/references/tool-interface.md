# Midcompact Tool Interface

Read this reference when exact call requirements, limits, rejection behavior, repeated compression, or recall truncation matters. The main workflow remains in `../SKILL.md`.

## Inspect

Without `spans`, `action="inspect"` inventories the frozen anchor. It returns factual structure and bounded user landmarks, not full message bodies, assistant/tool previews, summaries, or image base64.

- `page_size`: default 20 groups, maximum 50.
- `cursor`: opaque value returned by the previous page.
- Results include group refs, atom spans, content chars, image facts, protected/compressible counts, and Pi-reported anchor usage.

Stop paging after the candidate regions are covered.

To compare explicit candidates without mutating the DraftPlan, pass one or more possibly overlapping spans:

```text
midcompact(action="inspect", spans=[
  {"start":"a0006","end":"a0014"},
  {"start":"a0006","end":"a0020"}
])
```

Span inspection reports bounded endpoint landmarks, atom/message and role counts, tool exchanges and calls, factual content share, images, and protected/compressible counts. It has a 12,000-character total output budget and reports how many requested spans fit. It does not report per-span tokens: Pi supplies usage for the whole anchor, not token attribution by range. Do not combine `spans` with `page_size` or `cursor`.

## Locate

`action="locate"` returns atoms from the frozen anchor. Supply either:

- `ref`: one direct atom lookup; or
- at least one real filter: `pattern`, `tool_name`, or `source` other than `any`.

With no lookup or filter it returns no matches rather than an error. Filtered searches return at most three brief candidates; when more match, the result reports the total and asks for a more specific pattern or additional filter. `direction` is `oldest` by default or `newest`; `limit` may request one to three results.

Brief direct lookups preserve both ends of an atom landmark. Pattern searches show a bounded excerpt around the match rather than the atom prefix. `detail="full"` is allowed only with one direct `ref` and preserves both ends with an explicit middle-omission marker when the 12,000-character atom limit is exceeded.

A `g...` inventory ref is not a locate ref; use the group's `a...` start/end landmarks.

## Plan

`action="plan"` uses `op="show"` by default. Agent and user mutate the same DraftPlan.

| op | Required fields |
|----|-----------------|
| `show` | none; optional `draft_id` for one range |
| `add` | `start`, `end`; optional `summary`, `topic` |
| `update` | `draft_id` and at least one of `summary`, `topic` |
| `remove` | `draft_id` |

Default show lists each range with bounded `from`, `to`, and `summary` landmarks plus factual metrics. Use `op="show", detail="full", draft_id="d1"` for one stored summary and endpoint previews under a 40,000-character total budget; full detail without `draft_id` is rejected. Show is read-only and does not persist a duplicate DraftPlan entry.

Add/update return the changed range in brief form; remove returns its id and compact draft totals. Mutation responses omit the Pi-awareness header and unchanged ranges. Use explicit show when complete awareness is needed.

An omitted or empty `summary` creates a pending range. Review can open it, but commit requires at least one range and a non-empty summary for every range. Changing boundaries requires removing the old range and adding the replacement.

### Add rejection conditions

| Condition | Response |
|-----------|----------|
| The range crosses a protected atom | Split the range around that atom |
| The range overlaps an existing draft range | Remove or replace the existing range first |
| `start` occurs after `end` | Correct the positional order |
| An atom ref is unknown | Re-run inspect/locate against the current transaction snapshot |

An atom is protected when its tool protocol is incomplete or orphaned, it represents an existing compressed block, its message kind is unsupported, or it lacks the persistent session entry needed to anchor compression.

## Telemetry

Explicit `plan show` includes Pi-reported anchor usage when available and factual draft measurements: original/replacement content chars, image count, and decoded payload bytes. Mutation results omit awareness and report only compact totals plus the changed range where one remains. Local character or image measurements are not converted into token savings or projected-token percentages. Use measurements to compare the proposal with user-directed depth, not as an optimization target.

## Repeated compression

Committed blocks appear as protected atoms in later transaction snapshots and cannot be compressed again. A later transaction may compress newly accumulated raw history around those blocks. Re-run inspect/locate because atom refs are transaction-local.

## Recall

`action="recall"` works independently of a planning transaction and reads committed blocks active on the current branch.

- Without `ref`, `pattern` searches block topics and summaries; `limit` defaults to 8 and has a maximum of 20.
- With `ref="c0001"`, the tool renders that block's stored messages.
- `detail="full"` raises the rendering cap when the normal result is truncated.

Recall has no paging. The truncation marker is `[truncated; refine the recall request or inspect the source session for more]`. If `detail="full"` still truncates before the needed detail, report that recall cannot expose the omitted content; do not infer it.
