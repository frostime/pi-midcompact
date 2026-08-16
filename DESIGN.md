# pi-midcompact design notes

This document records the extension's product contract and implementation invariants. Product behavior should remain stable even if the internal addressing or rendering changes.

## Product contract

- Mid-context compression is **non-destructive**. Original Pi session entries remain the source of truth.
- Compression can target **multiple non-contiguous middle ranges**. Important material inside a broader phase is preserved by leaving holes between compressed ranges.
- Compression is **branch-local and tree-versioned**. A compression committed after a historical tree point must not affect that earlier point; returning to the committed branch restores the projection.
- A human explicitly starts a transaction with `/midcompact`. MVP does not auto-start compression.
- `/midcompact` means only **start/freeze the anchor**. It does not accept or enforce a target compression percentage.
- Planning chatter happens after the frozen anchor and is abandoned at commit. The final working branch receives only the committed compression state, not a summary of maintenance discussion.
- Normal coding prompts do **not** receive permanent message IDs. Temporary atom refs exist only while resolving/reviewing a transaction.
- Semantic importance is decided by the Agent using the packaged Skill and human review. The extension does not special-case tool names.
- Protocol correctness is enforced by the extension. A tool-call exchange that cannot be proven closed is not compressible.
- Compressed information remains retrievable. `recall` reads original session content temporarily without changing the projection.
- A session can be compressed repeatedly. Existing compressed blocks are preserved and treated as protected atoms; later raw regions can be compressed incrementally. Recursive compression/consolidation is outside v0.2.0.

## Context awareness principle

The Agent needs scale perception, not an optimizer target.

At `/midcompact` start, the extension freezes Pi's reported context usage on the anchor. Draft telemetry then estimates:

- anchor tokens / context window / percentage;
- raw tokens selected by current draft ranges;
- approximate summary tokens;
- estimated savings;
- approximate whole-context usage if the draft were committed immediately.

This is explicitly **informational, not a quota or hard line**. The user can conversationally request a rough degree of reduction. The Agent should use the telemetry to understand scale while prioritizing semantic retention.

Projected usage is approximate because the hypothetical context has not been sent to the provider for exact token accounting.

## Agent-facing surface

The extension exposes one thin tool, `midcompact`, with three actions:

- `locate` — resolve a deterministic description against the frozen anchor snapshot and return readable atom previews plus temporary refs.
- `plan` — add, update, remove, or show draft compression ranges. Plan responses include context telemetry.
- `recall` — search active compressed summaries or retrieve original content for a compressed block.

Workflow/policy guidance lives in `skills/midcompact/SKILL.md`, not in a large tool description.

## Transaction lifecycle

```text
NORMAL BRANCH
T1 ... T50
        ^ anchor + frozen usage snapshot
        |
        +-- maintenance branch: locate -> plan -> human discussion/review

human runs /midcompact commit:
1. command context waits for Pi to be idle
2. rebuild/validate the draft against the frozen anchor snapshot
3. navigate back to anchor with summarize=false
4. append branch-local midcompact-state
5. label the state entry for /tree and render a durable transcript card
6. future context events project selected raw ranges into summaries
```

`/midcompact abort` returns to the anchor without a state commit.

## Addressing model

Three layers are separate:

1. **Pi session entries** — durable physical history nodes.
2. **Protocol atoms** — temporary indivisible units built from the anchor's effective message sequence.
3. **Semantic slices** — ranges the Agent chooses to compress.

Agent-visible refs such as `a0007` are transaction-local handles. They are not the primary persisted locator and are never injected into normal conversation messages.

Committed blocks persist original session entry IDs for recall, exact message fingerprints for request-time projection, summary/topic, and approximate token counts.

Projection is fail-open: if a persisted raw sequence cannot be resolved exactly, raw context is retained rather than deleting an uncertain range.

## Protocol atoms

The implementation is deliberately conservative:

- ordinary user/assistant/bash messages can be atoms when mapped to a session entry;
- an assistant message containing one or more tool calls plus its immediately following matching tool results is one atom;
- orphan or incomplete tool exchanges are protected;
- unknown/custom messages are protected;
- an already compressed summary is a protected atom during later transactions.

These rules are structural only. No tool name receives semantic privilege.

## Human observability and review

Human review is first-class because model-visible projection and user-visible transcript are otherwise asymmetric.

### Draft review

`/midcompact review` opens a native Pi custom TUI showing the anchor snapshot as a **linear atom timeline**. The user can see:

- `KEEP` atoms;
- each proposed draft range in place;
- range start/end and token estimates;
- proposed summary/topic;
- anchor and projected context awareness.

The user can edit summary/topic or remove a range. Boundary changes/additional KEEP holes can still be requested conversationally and applied by the Agent's `plan` action.

A Web UI is a possible later enhancement, not part of v0.2.0.

### Committed-state visibility

A committed state is visible to the human through two independent surfaces:

1. a `registerEntryRenderer` transcript card for the `midcompact-state` custom entry;
2. a persistent label attached to the state entry for Pi's `/tree` selector.

While a transaction is active, a separate `setStatus` indicator shows draft planning progress. It is cleared after commit or abort. These surfaces are human-facing only; they do not add normal LLM prompt metadata.

## Persistence and tree behavior

Compression state is stored as a Pi custom entry (`midcompact-state`) on the committed branch. Runtime state is rebuilt from the active branch on `session_start` and `session_tree`.

```text
T1 ... T30 ... T50 -> State S -> T80

/tree -> T30  => S absent from ancestry => original context
/tree -> T80  => S present in ancestry  => compressed projection
```

Draft/transaction state is also branch-local. Commit abandons it by navigating to the anchor before appending the final state.

Repeated commits append cumulative states. The latest state on a branch contains the prior blocks plus newly committed blocks, so tree rollback naturally restores the historical compression version present at that point.

## Recall

`recall(pattern=...)` searches active compressed block IDs/topics/summaries. `recall(ref=...)` resolves the block's persisted source entry IDs and returns readable original session content as a tool result. Recall is temporary and does not expand the projection.

## Technical validation still required in real Pi/provider workflows

- native/automatic `/compact` interaction after one or more midcompact states;
- unusual provider/message shapes and parallel tool calls;
- context-transform ordering with third-party extensions;
- practical stability of exact message fingerprints across long-lived sessions;
- richer recall for non-text content;
- usability of the native review TUI on very large anchor snapshots;
- whether long-lived sessions eventually need explicit compressed-block consolidation.

## Pi API boundary

The extension targets Pi v0.84.1. Agent tool execution uses ordinary `ExtensionContext`; session-control methods such as `waitForIdle()` and `navigateTree()` are used only by slash-command handlers with `ExtensionCommandContext`. Human-facing visibility uses Pi's custom-entry renderer, status UI, and entry labels rather than injecting bookkeeping into normal model messages.
