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

Three mechanical facts shape how you work:

- **KEEP by omission or by explicit KEEP.** Anything outside a draft range stays verbatim. You declare only what to compress, never what to preserve.
- **Originals survive.** Session entries stay on disk, and `action="recall"` brings an active committed block back into view. Compression is reversible at the information-access level, not a deletion — but recall returns a readable rendering, not a byte-exact replay, so it is no substitute for keeping something verbatim.
- **Projection is layered.** Compression applies to what future models see, not to stored history.

## Who decides what

| Actor | Owns |
|-------|------|
| Extension | Session-tree mechanics, projection, protocol safety, factual metrics, selection subtraction, runtime guards |
| You | Semantic judgment: which content may yield to a summary, and what each summary must carry |
| User | Compression scope and depth; explicit Selection confirmation; the only actor that can commit |

You cannot commit. `/midcompact commit` is the user's gate. Your output is a proposal.

## Three stages: inventory, selection, summary

A transaction moves through four phases, enforced by the runtime:

```
selecting -> selection-confirmed -> summarizing -> ready_for_review
```

- **Selection** is a persisted, editable, non-committable intent: requested spans plus KEEP refs. It survives UI close and reload.
- **Pending ranges** are the ordinary spans produced after the user explicitly confirms the Selection. Each needs its own non-empty summary.
- **Review draft** exists only when every pending range has a non-empty summary; only then can the user commit.

## What may be compressed

One conservation law decides every case:

> Compression must conserve every fact that can still affect the work **in the projected context**. After a range is replaced, each such fact must remain available with sufficient fidelity, either in text left verbatim outside the ranges or in the replacement summary.

Not age. Not token count. Not whether it is a tool call or prose. Two consequences follow:

- **The summary is load-bearing.** When a fact lives only inside a compressed range, omitting it from the summary removes it from the projected context. Recall is a recovery path, not a default carrier.
- **Some information must not be entrusted to paraphrase.** Exact requirement wording, literal error text, decision-critical evidence, protocol structure. When exact form or provenance matters, keep the source verbatim unless the replacement preserves it with equivalent fidelity.

Illustrative cases, derived from the law:

- Work that reached a conclusion or resolved result, with nothing downstream depending on how it got there → the summary states the outcome, or the concluding atom stays outside the range → compressible.
- Tool output fully absorbed into the answer that follows it → the answer sits outside the range → a thin summary suffices.
- A constraint, correction, or approval the user stated once → if the wording itself carries the constraint, keep it verbatim; otherwise the summary must state it explicitly.
- A rejected approach whose rejection reason still constrains current work → the summary must carry the reason; the exploration around it can go.

**Reverse failure.** Some content looks stale but is the only record of an environment quirk, a version-specific behavior, or a failure mode that will resurface. If you cannot state faithfully what a segment established, you cannot summarize it conservingly — keep it verbatim.

**Your summary becomes the successor.** The next working Agent — likely you, after commit — sees only your summary. Write what it needs to avoid redoing or breaking work: user intent and constraints, decisions and their rationale, file paths and signatures, validation state, unresolved issues, and the next useful state. Cutting repetitive exploration is the goal; shortening prose is not.

## Phase 1 — inventory, segment, propose

**Call `action="inspect"` first.** It returns a bounded, paginated view of the frozen anchor grouped by user message: atom spans, content chars, image facts, and protected/compressible counts — no body, preview, summary, or image base64. Page with the returned `cursor`; default 20 groups, max 50. Do not page through everything; stop once your candidates are covered.

1. From inventory, segment the conversation semantically — by phase of work, not message count.
2. Judge each segment against the conservation law. For each candidate, be able to say where its load-bearing facts would end up.
3. Present candidates: where each begins and ends (group/atom refs), its content chars and image count, and what its summary would carry. Name segments you deliberately excluded when the exclusion is non-obvious.
4. If scope or depth is still unresolved, ask how deep to go and which regions matter. Depth is the user's decision, not a number you optimize.

`locate` is read-only and may be used sparingly to confirm a boundary you are about to propose, but not to scan exploratorily. A session that has reached compression is already near its limit: speculative calls, and a plan rebuilt after review, both consume what you are trying to reclaim.

If `/midcompact start` carried an instruction (it arrives as `User focus: ...`), treat it as guidance for whichever of scope and depth it specifies. Still propose, but briefly; ask only what the instruction leaves open.

## Phase 2 — persist a candidate Selection, then wait for confirmation

1. Persist the proposal with `action="select"`, passing `spans` (JSON array of `{startRef,endRef}`) and `keep_refs` (JSON array of atom refs to KEEP inside the spans). A span may cross KEEP and protected atoms.
2. **Do not call `plan add` yet.** The runtime rejects it in the `selecting` phase.
3. Ask the user to run `/midcompact confirm` (or `action="confirm"`). Only after confirmation are pending ranges materialized and the phase advances to `summarizing`. Natural-language agreement alone is not a state transition.

## Phase 3 — summarize pending ranges, then review

1. After confirmation, `action="plan", op="show"` lists the materialized pending ranges (each with an empty summary). You may `action="locate"` a boundary atom to write an accurate summary, but do not move confirmed boundaries.
2. `action="plan", op="update", draft_id=..., summary=...` for each range. A range is not review-ready until its summary is non-empty.
3. Recommend `/midcompact review` when the user wants to inspect ranges, summaries, and KEEP holes visually. In non-interactive modes, `/midcompact review` points to `/midcompact review-webui`.
4. Ask the user to run `/midcompact commit` when every range is summarized. You cannot commit.

## Tool interface

**Atoms are not messages.** An atom is the smallest compressible unit. One assistant message containing one or more tool calls, plus its immediately following matching results, forms a single `tool_exchange` atom; you cannot compress half of one.

**Two ref namespaces.** `a0001` is an atom ref, valid only within the current transaction's anchor snapshot — indices shift after every commit, so never reuse one across transactions; re-run `locate`. `c0001` is a compressed block id, stable while that block stays active on the current branch, used by `recall`.

`action="inspect"` — bounded inventory of the frozen anchor, grouped by user message. Pass `page_size` (default 20, max 50) and `cursor` from the previous page. Returns group refs, atom spans, content chars, image count/MIME/payload bytes, protected/compressible counts, and Pi-reported usage. No body, preview, summary, or image base64.

`action="locate"` — pass either `ref` for a direct lookup, or at least one real filter: `pattern`, `tool_name`, or a `source` other than `any`. With none it returns nothing rather than an error. Optional: `direction` (`oldest`/`newest`), `limit` (default 5, max 20), `detail` (`brief`/`full`).

`action="select"` — persist a candidate Selection (unconfirmed). `spans` is a JSON array of `{startRef,endRef}`; `keep_refs` is a JSON array of atom refs to KEEP. Spans may cross KEEP/protected atoms; the extension subtracts them, and compressing only a protected atom is rejected. Rejected after the Selection is confirmed.

`action="confirm"` — confirm the current Selection, materialize pending ranges, advance to `summarizing`. Equivalent to `/midcompact confirm`.

`action="plan"` — `op` defaults to `show`.

| op | Requires |
|----|----------|
| `show` | — |
| `add` | `start`, `end`, `summary`; `topic` optional (only after Selection is confirmed) |
| `update` | `draft_id` and at least one of `summary`, `topic` |
| `remove` | `draft_id` |

`op="add"` rejects a range when any of the following holds. These are mechanical constraints, independent of semantic value — a range must satisfy both.

| Condition | Meaning |
|-----------|---------|
| Range crosses a protected atom | Split the plan around it. An atom is protected when its tool-call protocol is still open (an incomplete `tool_exchange`, or an orphaned tool result), when it is an existing compressed block, when its message kind is not one the extension can compress, or when its messages have no persistent session entry to anchor to. |
| Range overlaps an existing draft range | Remove or update that range instead. |
| `start` occurs after `end` | Refs are positional; order them. |
| Unknown atom ref | Usually a typo or a ref carried over from an earlier transaction. Re-run `locate` against the current snapshot. |

**Telemetry** accompanies every `plan` result: **Pi-reported** anchor usage (labelled, may be `unavailable`) and factual **content chars** / image count / MIME / decoded payload bytes for the draft and its pending summaries. The extension never converts local character counts or image bytes into token claims, and presents no local token-savings or projected-token-percentage figures. Use it to check the draft against the depth agreed in Phase 1. It is awareness, not a target.

## Repeated compression

A session may be compacted multiple times. Committed blocks stay active and appear as protected atoms in later snapshots, so they cannot be recompressed. A later transaction compresses raw history accumulated around them.

## Recall

`action="recall"` works whether or not a transaction is active, does not change the projection, and reads blocks active on the current branch.

- `pattern="..."` searches topics and summaries of active blocks (`limit` default 8, max 20).
- `ref="c0001"` returns a readable, structure-flattened rendering of that block's messages, truncated if long. On a truncation marker, retry the same ref with `detail="full"`; if that still truncates, inspect the session tree. There is no paging.

Every summary in context states its own block id and the exact recall call for it. Use recall when a summary lacks a detail the current work needs.
