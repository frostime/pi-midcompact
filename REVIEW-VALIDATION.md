# Independent validation against Pi v0.84.1

This note records the independent re-check performed after receiving an external review. It is not a substitute for running the extension in a real Pi process.

## Confirmed and fixed

- **Tool context cannot navigate the session tree.** `ToolDefinition.execute` receives `ExtensionContext`; `waitForIdle()` and `navigateTree()` are only on `ExtensionCommandContext`. The old prototype's Agent-side `commit` path was invalid. The Agent tool now has only `locate`, `plan`, and `recall`; the human command `/midcompact commit` performs tree navigation.
- **The old mock/type setup hid that API violation.** The all-`any` Pi shims were removed. Offline tests now use a narrow contract declaration that intentionally keeps `navigateTree` out of the tool context. The normal `typecheck` script is reserved for real Pi packages.
- **The same context split exists in v0.80.6.** The failure was not introduced by Pi v0.84.1. This prototype nevertheless targets v0.84.1 exactly rather than claiming untested compatibility across the whole version interval.
- **No-UI confirmation was a second problem in the old Agent-side commit path.** Pi's no-op UI returns `false` for `confirm`. Commit is now an explicit human slash command and does not depend on a modal confirmation from a tool call.

## Source-confirmed behavior retained

- `navigateTree(..., { summarize: false })` changes the leaf and awaits the `session_tree` extension event before returning. Appending `midcompact-state` afterward therefore lands on the intended anchor branch.
- Pi custom entries do not participate in LLM context, so transaction/draft/state entries are suitable for branch-local persistence.
- `context` handlers are chained in extension load order; therefore exact fingerprint projection remains intentionally fail-open when another context transformer changes messages before this extension.
- A `role: "custom"` projection message is converted to an LLM `user` message; extension-only `details` are stripped. The visible summary text therefore carries the block ID/recall hint itself.
- Pi's branch-session creation copies the active path, including custom entries, while preserving entry IDs. This is compatible with branch-local compression state and recall references when forking from a point after a committed state; forking from before that state naturally omits it.

## Still requires real-runtime/provider validation

- Exact fingerprint stability through real session/context transforms, especially old or hand-edited sessions and third-party context extensions.
- Provider behavior for unusual multi-tool histories and for synthetic mid-history summary messages.
- Interaction with Pi native/automatic compaction.
- Session switching/RPC concurrency beyond the normal one-active-session CLI lifecycle.
- Non-text recall rendering (images and richer details).

## Additional implementation note

The prototype now pins its peer/dev Pi dependencies to **0.84.1**. The v0.80.6 source was used only to verify that the fatal tool-vs-command context boundary was not a recent regression.
