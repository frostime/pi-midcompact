# Midcompact Tool Interface

Read this reference when exact call requirements, limits, rejection behavior, repeated compression, or recall truncation matters. The main workflow remains in `../SKILL.md`.

## Inspect

`action="inspect"` inventories the frozen anchor without returning message bodies, previews, summaries, tool output, or image base64.

- `page_size`: default 20 groups, maximum 50.
- `cursor`: opaque value returned by the previous page.
- Results include group refs, atom spans, content chars, image facts, protected/compressible counts, and Pi-reported anchor usage.

Stop paging after the candidate regions are covered.

## Locate

`action="locate"` returns atoms from the frozen anchor. Supply either:

- `ref`: one direct atom lookup; or
- at least one real filter: `pattern`, `tool_name`, or `source` other than `any`.

With no lookup or filter it returns no matches rather than an error. Optional fields:

- `direction`: `oldest` (default) or `newest`;
- `limit`: default 5, maximum 20;
- `detail`: `brief` (default) or `full`.

A `g...` inventory ref is not a locate ref; use the group's `a...` start/end landmarks.

## Plan

`action="plan"` uses `op="show"` by default. Agent and user mutate the same DraftPlan.

| op | Required fields |
|----|-----------------|
| `show` | none |
| `add` | `start`, `end`; optional `summary`, `topic` |
| `update` | `draft_id` and at least one of `summary`, `topic` |
| `remove` | `draft_id` |

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

Every plan result includes Pi-reported anchor usage when available and factual draft measurements: original/replacement content chars and image count, MIME, and decoded payload bytes. Local character or image measurements are not converted into token savings or projected-token percentages. Use telemetry to compare the proposal with user-directed depth, not as an optimization target.

## Repeated compression

Committed blocks appear as protected atoms in later transaction snapshots and cannot be compressed again. A later transaction may compress newly accumulated raw history around those blocks. Re-run inspect/locate because atom refs are transaction-local.

## Recall

`action="recall"` works independently of a planning transaction and reads committed blocks active on the current branch.

- Without `ref`, `pattern` searches block topics and summaries; `limit` defaults to 8 and has a maximum of 20.
- With `ref="c0001"`, the tool renders that block's stored messages.
- `detail="full"` raises the rendering cap when the normal result is truncated.

Recall has no paging. The truncation marker is `[truncated; refine the recall request or inspect the source session for more]`. If `detail="full"` still truncates before the needed detail, report that recall cannot expose the omitted content; do not infer it.
