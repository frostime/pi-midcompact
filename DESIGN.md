# pi-midcompact design notes

This document records the prototype's architectural contract. It intentionally separates product behavior from implementation details so the latter can change without changing the user-facing semantics.

## Product contract

- Mid-context compression is **non-destructive**. Original Pi session entries remain the source of truth.
- Compression can target **multiple non-contiguous middle ranges**. Important material inside a broader phase is preserved by leaving holes between compressed ranges.
- Compression is **branch-local and tree-versioned**. A compression committed after a historical tree point must not affect that earlier point; returning to the committed branch restores the projection.
- A human explicitly starts a transaction with `/midcompact` and reviews the draft before commit. MVP does not auto-start compression.
- Planning chatter happens after a frozen **anchor** and is abandoned at commit. The final working branch receives only the committed compression state, not a summary of the maintenance conversation.
- Normal coding prompts do **not** receive permanent message IDs. Temporary atom refs exist only while resolving and reviewing a transaction.
- Semantic importance is decided by the Agent using the packaged Skill and human review. The extension does not special-case tool names.
- Protocol correctness is enforced by the extension. A tool-call exchange that cannot be proven closed is not compressible.
- Compressed information remains retrievable. `recall` reads original session content temporarily without changing the projection. Persistent decompression is outside the MVP.

## Agent-facing surface

The extension exposes one thin tool, `midcompact`, with three actions:

- `locate` — resolve a deterministic description against the frozen anchor snapshot and return readable atom previews plus temporary refs.
- `plan` — add, update, remove, or show draft compression ranges.
- `recall` — search active compressed summaries or retrieve original content for a compressed block.

Workflow/policy guidance lives in `skills/midcompact/SKILL.md`, not in a large tool description.

## Transaction lifecycle

```text
NORMAL BRANCH
T1 ... T50
        ^ anchor
        |
        +-- maintenance branch: locate -> plan -> human review

human runs /midcompact commit:
1. the command context waits for Pi to be idle
2. validate the draft against the frozen anchor snapshot
3. navigate back to the anchor with summarize=false
4. append a branch-local `midcompact-state` custom entry
5. future `context` events project the selected raw ranges into summaries
```

`/midcompact abort` navigates back to the anchor without committing a state.

## Addressing model

Three layers are kept separate:

1. **Pi session entries** — durable physical history nodes.
2. **Protocol atoms** — temporary indivisible units built from the anchor's effective message sequence.
3. **Semantic slices** — ranges the Agent chooses to compress.

Agent-visible refs such as `a0007` are transaction-local handles. They are not persisted as the primary locator and are never injected into normal conversation messages.

Committed blocks persist:

- original session entry IDs for recall;
- exact message fingerprints for request-time projection;
- summary/topic and token estimates.

Projection is fail-open: if a persisted raw sequence cannot be resolved exactly, raw context is retained rather than deleting an uncertain range.

## Protocol atoms

The MVP is deliberately conservative:

- ordinary user/assistant/bash messages can be atoms when mapped to a session entry;
- an assistant message containing one or more tool calls plus its immediately following matching tool results is one atom;
- orphan or incomplete tool exchanges are protected;
- unknown/custom messages are protected;
- an already compressed summary is protected from nested re-compression in the MVP.

These rules are structural only. No tool name receives semantic privilege.

## Persistence and tree behavior

Compression state is stored as a Pi custom entry (`midcompact-state`) on the committed branch. Runtime state is rebuilt from the active branch on `session_start` and `session_tree`.

The intended invariant is:

```text
T1 ... T30 ... T50 -> State S -> T80

/tree -> T30  => S is absent from ancestry => original context
/tree -> T80  => S is present in ancestry  => compressed projection
```

Draft/transaction state is also branch-local. Commit abandons it by navigating to the anchor before appending the final state.

## Human review

The maintenance conversation is the MVP review surface. The Agent shows the complete draft and the user can request edits. Only the human-facing `/midcompact commit` command can commit; this matches Pi's API boundary because tree navigation is available only in command contexts. A dedicated Web UI is intentionally deferred until the compression semantics are validated in real workflows.

## Recall

`recall(pattern=...)` searches active compressed block IDs/topics/summaries. `recall(ref=...)` resolves the block's persisted source entry IDs and returns readable original session content as a tool result. Recall is temporary and does not expand the active projection.

## Technical validation still required in a real Pi runtime

These are implementation questions, not unresolved product requirements:

- provider-level behavior for unusual/multi-tool message shapes;
- exact interaction with Pi native `/compact`;
- ordering with third-party `context` transformers;
- real prefix-cache behavior;
- richer deterministic locator ergonomics;
- whether recall rendering should preserve additional non-text content representations.

## Pi API boundary

This prototype targets Pi v0.84.1. The same registered-tool/command-context split was also verified in v0.80.6: registered tool execution uses `ExtensionContext`; session-control methods such as `waitForIdle()` and `navigateTree()` exist only on `ExtensionCommandContext`. Therefore tree navigation is intentionally confined to `/midcompact commit` and `/midcompact abort`. The Agent-facing tool never captures or reuses a command context.
