---
name: midcompact
description: Use during an active /midcompact transaction to selectively compress stale middle sections of a long Pi conversation, or later to recall exact details from compressed blocks.
---

# Midcompact

Use this skill only when a `/midcompact` transaction is active, or when exact information must be recovered from a previously compressed block.

## Mental model

The transaction is based on a frozen anchor snapshot. Maintenance discussion, locator calls, draft revisions, and review happen on a temporary branch. A successful commit returns to the anchor without summarizing that maintenance branch, then stores only the reviewed compression projection.

The extension handles session-tree mechanics and protocol safety. You decide semantic value.

Do not infer importance from a tool name. A user constraint, approval, correction, decision, or other critical fact may appear inside any message or tool exchange. Inspect actual content.

## Context awareness

The tool reports approximate context telemetry while planning:

- anchor usage captured when `/midcompact` started;
- approximate raw tokens selected by the current draft;
- approximate summary tokens;
- approximate whole-context usage if the draft were committed now.

Treat these numbers as **awareness, not a target**. Do not maximize token reduction or keep adding ranges merely because more compression is possible. Use the scale information together with semantic value and the user's conversational guidance. If the user says they only want a modest reduction, preserve more context; if they want more headroom, look for additional stale regions.

Projected values are estimates. Prefer semantic correctness over apparent numeric precision.

## Compression workflow

1. Decide which completed or stale regions are candidates for compression.
2. Use `midcompact(action="locate", ...)` to resolve semantic landmarks to atom refs. Locator results include readable previews; request `detail="full"` when a boundary is ambiguous.
3. Build a draft with `midcompact(action="plan", op="add", start=..., end=..., summary=...)`.
   - Use multiple ranges for non-contiguous compression.
   - To preserve an important atom verbatim inside a broader phase, split the compression into ranges around that atom.
   - Prefer KEEP-by-omission when uncertain.
   - After each meaningful draft change, use the returned context telemetry to understand its scale; do not treat it as a quota.
4. Use `midcompact(action="plan", op="show")` and present the complete proposed plan to the user. Include what each range begins/ends with, not only atom IDs.
5. Recommend `/midcompact review` when the user wants to inspect the linear anchor timeline, proposed ranges, summaries, and KEEP holes. Incorporate requested changes with `op="update"`, `op="remove"`, additional ranges, or the review UI.
6. After the user is satisfied, ask them to run `/midcompact commit`. The Agent cannot commit itself. The explicit user command is the commit gate and returns the session tree to the anchor before persisting the projection.

A good summary preserves what the next working Agent needs: user intent and constraints, decisions and rationale, relevant file paths/signatures/errors, validation state, rejected approaches when the reason matters, unresolved issues, and the next useful state. Remove repetitive exploration and process noise rather than merely shortening prose.

## Repeated compression

A session may be midcompacted multiple times. Existing compressed blocks remain active and protected; a later transaction can compress newly accumulated raw history around them. Do not attempt to recursively compress an already compressed block in the current version.

## Recall

Compression is reversible at the information-access level. Original session entries remain stored.

- `midcompact(action="recall", pattern="...")` searches active compressed block summaries/topics.
- `midcompact(action="recall", ref="c0001")` temporarily returns the original content for that block.

Recall does not change the compression projection. Use it when a summary lacks a detail needed for current work.
