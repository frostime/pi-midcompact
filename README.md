# pi-midcompact

Branch-aware, reversible mid-context compression for the Pi coding agent.

`pi-midcompact` lets a human and Agent selectively summarize stale middle regions of a long session without permanently injecting message IDs into normal prompts and without deleting original session history.


## Workflow

1. The human runs `/midcompact` at a clean point. This freezes an anchor and captures context-usage awareness.
2. A maintenance branch is created after the anchor. The Agent loads the packaged skill and uses the thin `midcompact` tool:
   - `locate` — find readable protocol atoms in the frozen anchor snapshot;
   - `plan` — add/update/remove/show proposed compression ranges;
   - `recall` — search or temporarily recover original content from already compressed blocks.
3. The Agent and human discuss the plan normally. Planning chatter stays on the maintenance branch.
4. The human can run `/midcompact review` for a linear TUI view of exactly which atoms are proposed for compression and which remain verbatim.
5. When satisfied, the human runs `/midcompact commit`. The command waits for idle, navigates back to the anchor with `summarize:false`, and appends a branch-local compression state.
6. Future `context` calls project matching raw ranges into summary messages. The original session entries remain untouched and recallable.

## Commands

```text
/midcompact          start a transaction at the current leaf
/midcompact review   inspect/edit the draft in the TUI
/midcompact status   show current draft or active compression state
/midcompact commit   commit the reviewed draft
/midcompact abort    return to the anchor without committing
```

`/midcompact` intentionally has no percentage or token-budget parameter. If the user wants a particular rough degree of reduction, they tell the Agent conversationally; the telemetry gives the Agent enough scale information to reason about that request.

## Review TUI

The review screen shows a linear representation of the frozen anchor context. Each atom is visibly marked either `KEEP` or with the draft range that owns it.

Controls:

```text
n/p or ←/→    select proposed range
↑/↓, j/k      scroll
PgUp/PgDn     page
x             expand selected range atoms
e             edit selected summary
t             edit selected topic
d             remove selected range
Enter/Esc/q   close
```

This is the default human-review surface. A browser/Web review UI is intentionally deferred until the native TUI has been exercised in real workflows.

## Context telemetry

At transaction start, the extension snapshots Pi's reported context usage. While drafting it reports approximately:

```text
anchor:                   143k / 200k (71.5%)
draft selection:           57k -> 1.2k
estimated saving:          55.8k
projected if committed:   ~87k / 200k (~43.5%)
```

The selected-range and projected values are estimates, because a hypothetical projection has not been provider-tokenized yet. The purpose is perception: the Agent should understand whether a proposed draft is small, moderate, or aggressive relative to the whole context.

## Important semantics

- **Branch-local state.** `/tree` to a point before a compression commit restores raw history; returning to a descendant of the committed state restores the projection.
- **Non-destructive.** Original session entries are never deleted.
- **No permanent message-ID injection.** Transaction-local atom refs are only exposed on demand during maintenance.
- **Protocol-safe atoms.** Tool call/result exchanges are kept structurally closed. Unknown or incomplete exchanges fail closed and cannot be compressed.
- **Semantic policy belongs to the Agent/skill.** No tool name is hard-coded as important or disposable.
- **Human gate.** The Agent cannot commit; `/midcompact commit` is a user command.
- **Recall is temporary.** Reading original compressed content does not expand the active projection.
- **Repeated transactions are supported.** Existing compressed blocks stay protected; later raw context can be compressed incrementally.

## Installation

For a local checkout:

```bash
pi install /absolute/path/to/pi-midcompact
```

Then restart Pi or run `/reload`.

## Compatibility baseline

This version targets Pi **0.84.1** exactly. The registered tool uses only ordinary `ExtensionContext`; tree navigation remains confined to slash-command handlers where Pi exposes `ExtensionCommandContext`.

## Known limitations / validation targets

- Native/automatic Pi `/compact` interoperability still needs broader real-session testing.
- Atom construction is intentionally conservative, especially for unusual parallel/multi-tool message shapes.
- Exact message-fingerprint projection can fail open if another `context` extension rewrites the same messages before `pi-midcompact`.
- Review is TUI-only in v0.2.0; there is no Web UI yet.
- Locator matching is deterministic text/source/tool-name matching, not embeddings.
- Existing compressed blocks cannot yet be recursively re-compressed or consolidated.
- Token sizing uses approximate message estimates for hypothetical draft reductions.

## Design references

The implementation borrows mechanisms rather than complete architectures from `ttttmr/pi-context`, `Reindeer-AI/pi-context-curator`, `championswimmer/pi-context-prune`, and the separately reviewed `session-prune` prototype.
