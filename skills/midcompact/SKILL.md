---
name: midcompact
description: Use during an active /midcompact transaction to plan and draft selective compression of stale middle sections of a long Pi conversation, or independently to retrieve details from previously compressed blocks. Covers how to choose compression ranges, how to negotiate compression depth with the user, and the midcompact tool interface.
---

# Midcompact

Use this skill when a `/midcompact start` transaction is active, or when information must be retrieved from a previously compressed block.

## What compression does

Mid-context compaction is **selective replacement** inside one linear conversation, not a restart:

```
A → B → C → ... → NOW
      └─ selected slices become summaries; everything else stays verbatim
```

Three mechanical facts that determine how you should work:

- **KEEP by omission.** Anything not inside a draft range stays verbatim. You declare only what to compress, never what to preserve.
- **Originals survive.** Session entries remain on disk, and `action="recall"` can bring an active committed block's content back into view. Compression is reversible at the information-access level, not a deletion — but recall returns a readable rendering, not a byte-exact replay, so do not treat it as a substitute for keeping something verbatim.
- **Projection is layered.** Compression applies to what future models see, not to stored history.

## Who decides what

| Actor | Owns |
|-------|------|
| Extension | Session-tree mechanics, projection, protocol safety |
| You | Semantic judgment: which content may yield to a summary, and what each summary must carry |
| User | Compression scope and depth; the only actor that can commit |

You cannot commit. `/midcompact commit` is the user's gate. Your output is a proposal.

## What may be compressed

One conservation law decides every case:

> Compression must conserve every fact that can still affect the work **in the projected context**. After a range is replaced, each such fact must remain available with sufficient fidelity either in text left verbatim outside the ranges, or in the replacement summary.

Not age. Not token count. Not whether it is a tool call or prose. Two consequences shape everything else:

- **The summary is load-bearing.** When a fact lives only inside a compressed range, omitting it from the summary removes it from the projected context. Recall is a recovery path, not a default carrier.
- **Some information must not be entrusted to paraphrase.** Exact requirement wording, literal error text, decision-critical evidence, protocol structure. When exact form or provenance matters, keep the source verbatim unless the replacement preserves it with equivalent fidelity.

Illustrative cases, all derived from the law above:

- Exploration that ended in a conclusion → summary states the conclusion, or the concluding atom stays outside the range → compressible.
- Tool output fully absorbed into the answer that follows it → the answer sits outside the range → a thin summary suffices.
- A resolved sub-task with no downstream dependency → summary states the result → compressible.
- A constraint, correction, or approval the user stated once → if the wording itself carries the constraint, keep it verbatim; otherwise the summary must state it explicitly.
- A rejected approach whose rejection reason still constrains current work → the summary must carry the reason; the exploration around it can go.

**Reverse failure.** Some content looks stale but is the only record of an environment quirk, a version-specific behavior, or a failure mode that will resurface. If you cannot state faithfully what a segment established, you cannot write a summary that conserves it — keep it verbatim.

**Your summary becomes the successor.** The next working Agent — likely you, after commit — sees only your summary. Write what that Agent needs to avoid redoing or breaking work: user intent and constraints, decisions and their rationale, file paths and signatures, validation state, unresolved issues, and the next useful state. Removing repetitive exploration is the goal; shortening prose is not.

## Phase 1 — read, segment, propose, align

**Do not call `plan` until you have presented the semantic candidates and the user has confirmed or adjusted the direction**, unless the user explicitly instructs you to skip the proposal.

1. Read back over the conversation in your current context and segment it semantically — by phase of work, not by message count.
2. Judge each segment against the conservation law. For each compressible candidate, be able to say where its load-bearing facts would end up.
3. Present candidates to the user: where each begins and ends, roughly how large it is, and what its summary would have to carry. Name segments you deliberately excluded when the exclusion is non-obvious.
4. If scope or depth is still unresolved, ask how deep they want to go and which regions they care about. Compression depth is their decision, not a number you optimize.

`locate` is read-only and may be used sparingly here to confirm a boundary you are about to propose. Do not use it to scan exploratorily: a session that has reached compression is already near its context limit, and speculative calls consume exactly what you are trying to reclaim.

This phase prevents drafting over regions the user never wanted touched, and prevents a plan that has to be rebuilt after the first review.

If `/midcompact start` carried an instruction (it arrives as `User focus: ...`), treat it as guidance for whichever of scope and depth it specifies. Still propose, but keep it brief; ask only about decisions the instruction leaves open.

## Phase 2 — locate, draft, review

1. `action="locate"` to resolve the landmarks you agreed on into atom refs. Results include previews; request `detail="full"` when a boundary is ambiguous.
2. `action="plan", op="add"` per range. Use several ranges for non-contiguous compression. To keep one important atom verbatim inside a broader phase, add ranges around it — that is KEEP by omission in practice.
3. `action="plan", op="show"` and present the complete plan to the user, described by content rather than atom IDs.
4. Recommend `/midcompact review` when the user wants to inspect the anchor timeline, ranges, summaries, and KEEP holes visually. Apply requested changes with `op="update"`, `op="remove"`, or new ranges.
5. Ask the user to run `/midcompact commit` when they are satisfied.

## Tool interface

**Atoms are not messages.** An atom is the smallest compressible unit. One assistant message containing one or more tool calls, plus its immediately following matching results, forms a single `tool_exchange` atom. You cannot compress half of one.

**Two ref namespaces.** `a0001` is an atom ref, valid only within the current transaction's anchor snapshot — indices shift after every commit, so never reuse an atom ref across transactions; re-run `locate`. `c0001` is a compressed block id, stable for as long as that block stays active on the current branch, used by `recall`.

`action="locate"` — pass either `ref` for a direct lookup, or at least one real filter: `pattern`, `tool_name`, or a `source` other than `any`. Without one it returns nothing rather than an error. Optional: `direction` (`oldest`/`newest`), `limit` (default 5, max 20), `detail` (`brief`/`full`).

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
| Range crosses a protected atom | Split the plan around it. An atom is protected when its tool-call protocol is still open (including an orphaned tool result), when it is an existing compressed block, when its message kind is not one the extension can compress, or when its messages have no persistent session entry to anchor to. |
| Range overlaps an existing draft range | Remove or update the existing range instead. |
| `start` occurs after `end` | Refs are positional; order them. |
| Unknown atom ref | Usually a typo or a ref carried over from an earlier transaction. Re-run `locate` against the current snapshot. |

**Protocol closure** is why some boundaries are refused: a `tool_exchange` atom is compressible only when the call and every one of its results are present and closed. This constraint is independent of semantic value — a range must satisfy both.

**Telemetry** accompanies every `plan` result: anchor usage at start, approximate raw and summary tokens for the current draft, and projected whole-context usage if committed now. Use it to check whether the draft matches the depth you agreed with the user in Phase 1. It is awareness, not a target, and the projections are estimates.

## Repeated compression

A session may be compacted multiple times. Committed blocks stay active and are protected — they appear as protected atoms in later snapshots and cannot be recompressed. A later transaction compresses newly accumulated raw history around them.

## Recall

`action="recall"` works whether or not a transaction is active, and does not change the compression projection. It reads blocks active on the current branch.

- `pattern="..."` searches topics and summaries of active blocks (`limit` default 8, max 20).
- `ref="c0001"` returns a readable rendering of that block's messages. Structure is flattened and long blocks are truncated; if the output ends in a truncation marker, retry the same ref with `detail="full"` for a larger cap, and inspect the session tree if that still truncates. There is no way to page through a block.

Every summary in context states its own block id and the exact recall call to retrieve it. Use recall when a summary lacks a detail the current work needs.
