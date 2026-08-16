# pi-midcompact (prototype)

Branch-aware, reversible mid-context compression for the Pi coding agent.

This prototype explores a specific design: arbitrary middle-context compression without permanently injecting message IDs into normal prompts, and without leaving the compression-planning conversation on the main working branch.

## Core behavior

1. The human runs `/midcompact` at a clean point.
2. The extension records that leaf as an anchor and starts a maintenance branch.
3. The Agent loads the `midcompact` skill and uses one thin `midcompact` tool:
   - `locate` — resolve semantic landmarks to readable protocol-safe atom refs.
   - `plan` — add/update/remove/show proposed compression ranges.
   - `recall` — search compressed blocks or temporarily retrieve exact original content.
4. After review, the human runs `/midcompact commit`. Because Pi exposes tree navigation only to command contexts, commit is deliberately a user command rather than an Agent tool action. The command waits for idle, navigates back to the anchor with `summarize:false`, and appends a branch-local `midcompact-state` custom entry.
5. A `context` hook projects matching raw message ranges into summary messages for future provider requests. Original session entries are never deleted.

## Important semantics

- **Branch-local state:** state is restored from the current active branch. Tree-navigation to a point before a compression commit removes that future compression from the active projection; navigating back restores it.
- **No persistent message-ID injection:** normal prompts are untouched except for committed summary projections. Atom refs exist only during a maintenance transaction.
- **Protocol atoms:** the prototype treats an assistant message containing tool calls plus its immediately following matching tool results as one indivisible atom. Orphan/incomplete exchanges fail closed and cannot be compressed.
- **Semantic policy belongs to the Agent/skill:** the extension does not special-case tool names or assume that particular tool results are low/high value.
- **Human gate:** only the human-facing `/midcompact commit` command can commit; the Agent tool cannot navigate the tree or commit state.
- **Recall is temporary:** original session entries are retrieved as a tool result; the compressed projection is not expanded permanently.

## Installation

For a local checkout:

```bash
pi install /absolute/path/to/pi-midcompact
```

Then restart Pi or run `/reload`.

## Usage

Start:

```text
/midcompact
```

Review the Agent's draft, then commit, inspect status, or abort:

```text
/midcompact commit
/midcompact status
/midcompact abort
```

The Agent should follow the packaged `midcompact` skill rather than relying on a large tool description.

## Prototype limitations / next validation targets

- Native Pi `/compact` interoperability is not finalized yet.
- Atom construction is intentionally conservative and needs provider-level integration tests, especially around parallel/multi-tool messages.
- Projection locators use stable message fingerprints plus branch-local persisted state; exact compatibility with every third-party `context` transformer is not guaranteed because Pi context transforms are order-dependent.
- No Web review UI yet; review happens in the maintenance conversation, and the explicit `/midcompact commit` command is the commit gate.
- Locator MVP uses deterministic text/source/tool-name matching, not embeddings.
- Existing compressed blocks are treated as protected atoms during a new transaction; nested/re-compression is not implemented.

## Design references

The prototype deliberately borrows mechanisms, not whole architectures, from:

- `ttttmr/pi-context`: Pi tree navigation timing, skills + extension packaging, agentic context-management workflow.
- `Reindeer-AI/pi-context-curator`: branch-restored custom state, non-destructive request-time projection, summary recall handles.
- `championswimmer/pi-context-prune`: cold-history/retrieval principle and non-destructive context pruning.
- the reviewed `session-prune` prototype: human-review workflow and separation between planning artifacts and final working context.

## Pi API baseline

This prototype targets Pi v0.84.1 exactly. The key context split was also cross-checked against v0.80.6: registered tool execution receives `ExtensionContext`, while `waitForIdle()` and `navigateTree()` are command-context-only APIs. The normal `typecheck` script is intended to run against the real Pi packages declared in devDependencies; offline tests use a narrow contract declaration instead of `any` shims.
