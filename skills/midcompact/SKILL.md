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

## Compression workflow

1. Decide which completed or stale regions are candidates for compression.
2. Use `midcompact(action="locate", ...)` to resolve semantic landmarks to atom refs. Locator results include readable previews; request `detail="full"` when a boundary is ambiguous.
3. Build a draft with `midcompact(action="plan", op="add", start=..., end=..., summary=...)`.
   - Use multiple ranges for non-contiguous compression.
   - To preserve an important atom verbatim inside a broader phase, split the compression into ranges around that atom.
   - Prefer KEEP-by-omission when uncertain.
4. Use `midcompact(action="plan", op="show")` and present the complete proposed plan to the user. Incorporate requested changes with `op="update"`, `op="remove"`, or additional ranges.
5. After the user has reviewed the plan, present the final draft and ask the user to run `/midcompact commit`. The Agent cannot commit itself. The explicit user command is the commit gate and returns the session tree to the anchor before persisting the projection.

A good summary preserves what the next working Agent needs: user intent and constraints, decisions and rationale, relevant file paths/signatures/errors, validation state, rejected approaches when the reason matters, unresolved issues, and the next useful state. Remove repetitive exploration and process noise rather than merely shortening prose.

## Recall

Compression is reversible at the information-access level. Original session entries remain stored.

- `midcompact(action="recall", pattern="...")` searches active compressed block summaries/topics.
- `midcompact(action="recall", ref="c0001")` temporarily returns the original content for that block.

Recall does not change the compression projection. Use it when a summary lacks a detail needed for current work.
