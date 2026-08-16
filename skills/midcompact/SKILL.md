---
name: midcompact
description: Use during an active /midcompact transaction to plan and draft selective compression of stale middle sections of a long Pi conversation, or independently to recall exact details from previously compressed blocks. Covers how to choose compression ranges, how to negotiate compression depth with the user, and the midcompact tool interface.
---

# Midcompact

Use this skill when a `/midcompact start` transaction is active, or when exact information must be recovered from a previously compressed block.

## What compression does

Mid-context compaction is **selective replacement** inside one linear conversation, not a restart:

```
A → B → C → ... → NOW
      └─ selected slices become summaries; everything else stays verbatim
```

Three mechanical facts that determine how you should work:

- **KEEP by omission.** Anything not inside a draft range stays verbatim. You declare only what to compress, never what to preserve.
- **Originals survive.** Session entries remain on disk. `action="recall"` returns the exact original content of a committed block at any time. Compression is reversible at the information-access level, not a deletion.
- **Projection is layered.** Compression applies to what future models see, not to stored history.

## Who decides what

| Actor | Owns |
|-------|------|
| Extension | Session-tree mechanics, projection, protocol safety |
| You | Semantic judgment: which content may yield to a summary, and what each summary must carry |
| User | Compression scope and depth; the only actor that can commit |

You cannot commit. `/midcompact commit` is the user's gate. Your output is a proposal.

## What may be compressed

One invariant decides every case:

> A slice may yield to a summary only if the information it carries has **already been carried forward** by later content.

Not age. Not token count. Not whether it is a tool call or prose. Derive each case from the invariant. Illustrative consequences:

- Exploration that ended in a conclusion → the conclusion carries the process → compressible.
- Tool output fully absorbed into the answer that follows it → compressible.
- A resolved sub-task with no downstream dependency → the result carries the work → compressible.
- A constraint, correction, or approval the user stated once and nobody restated → **nothing carries it** → keep verbatim.
- A rejected approach whose rejection reason still constrains current work → keep the reason, compress the exploration around it.

**Reverse failure.** Some content looks stale but is the only record of an environment quirk, a version-specific behavior, or a failure mode that will resurface. Nothing carried it forward because nothing needed to yet. Compressing it is a real loss. When you cannot tell whether something was carried forward, keep it.

**Your summary becomes the successor.** The next working Agent — likely you, after commit — sees only your summary. Write what that Agent needs to avoid redoing or breaking work: user intent and constraints, decisions and their rationale, file paths and signatures, validation state, unresolved issues, and the next useful state. Removing repetitive exploration is the goal; shortening prose is not.

## Phase 1 — read, segment, propose, align

**Do not call the tool yet.** Before any `locate` or `plan` call:

1. Read back over the conversation in your current context and segment it semantically — by phase of work, not by message count.
2. Judge each segment against the invariant. For each compressible candidate, be able to say *what carried its information forward*.
3. Present candidates to the user: where each begins and ends, roughly how large it is, and why it can yield. Name segments you deliberately excluded when the exclusion is non-obvious.
4. Ask how deep they want to go and which regions they care about. Compression depth is their decision, not a number you optimize.

This phase prevents burning context on `locate` calls probing regions the user never wanted touched, and prevents a draft that has to be rebuilt after the first review.

If `/midcompact start` carried an instruction (it arrives as `User focus: ...`), treat it as the user's starting scope. Still read back and still propose — but narrow the proposal to that scope instead of surveying the whole conversation.

## Phase 2 — locate, draft, review

1. `action="locate"` to resolve the landmarks you agreed on into atom refs. Results include previews; request `detail="full"` when a boundary is ambiguous.
2. `action="plan", op="add"` per range. Use several ranges for non-contiguous compression. To keep one important atom verbatim inside a broader phase, add ranges around it — that is KEEP by omission in practice.
3. `action="plan", op="show"` and present the complete plan to the user, described by content rather than atom IDs.
4. Recommend `/midcompact review` when the user wants to inspect the anchor timeline, ranges, summaries, and KEEP holes visually. Apply requested changes with `op="update"`, `op="remove"`, or new ranges.
5. Ask the user to run `/midcompact commit` when they are satisfied.

## Tool interface

**Atoms are not messages.** An atom is the smallest compressible unit. One assistant tool call plus all of its tool results collapse into a single `tool_exchange` atom. You cannot compress half of one.

**Two ref namespaces.** `a0001` is an atom ref, valid only within the current transaction's anchor snapshot — indices shift after every commit, so never reuse an atom ref across transactions; re-run `locate`. `c0001` is a compressed block id, persistent across transactions, used by `recall`.

`action="locate"` — requires at least one of `pattern`, `tool_name`, or `source`. Without one it returns nothing rather than an error. Optional: `ref` for a direct lookup, `direction` (`oldest`/`newest`), `limit` (default 5, max 20), `detail` (`brief`/`full`).

`action="plan"` — `op` defaults to `show`.

| op | Requires |
|----|----------|
| `show` | — |
| `add` | `start`, `end`, `summary`; `topic` optional |
| `update` | `draft_id` and at least one of `summary`, `topic` |
| `remove` | `draft_id` |

`op="add"` rejects a range when:

| Condition | Meaning |
|-----------|---------|
| Range crosses a protected atom | The atom is non-compressible, has an open tool-call protocol, or is an existing compressed block. Split the plan around it. |
| Range overlaps an existing draft range | Remove or update the existing range instead. |
| `start` occurs after `end` | Refs are positional; order them. |
| Unknown atom ref | The snapshot changed. Re-run `locate`. |

**Protocol closure** is why some boundaries are refused: a `tool_exchange` atom is compressible only when the call and every one of its results are present and closed. This constraint is independent of semantic value — a range must satisfy both.

**Telemetry** accompanies every `plan` result: anchor usage at start, approximate raw and summary tokens for the current draft, and projected whole-context usage if committed now. Use it to check whether the draft matches the depth you agreed with the user in Phase 1. It is awareness, not a target, and the projections are estimates.

## Repeated compression

A session may be compacted multiple times. Committed blocks stay active and are protected — they appear as protected atoms in later snapshots and cannot be recompressed. A later transaction compresses newly accumulated raw history around them.

## Recall

`action="recall"` works whether or not a transaction is active, and does not change the compression projection.

- `pattern="..."` searches topics and summaries of active blocks (`limit` default 8, max 20).
- `ref="c0001"` returns that block's original content.

Every summary in context states its own block id and the exact recall call to retrieve it. Use recall when a summary lacks a detail the current work needs.
