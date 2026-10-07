# Close WebUI recovery command

Implement `/midcompact:close-webui` without changing automatic disconnect or
reconnection policy. Preserve the saved plan and transaction. Warn about unsaved
browser edits; do not clear Agent-held or unrelated TUI locks.

- Track WebUI server handles per extension runtime until cleanup finishes.
- Return WebUI opening commands once ready, retaining the lock in asynchronous
  cleanup. Pi's idle input loop waits for commands; otherwise recovery queues
  behind the stuck opening command and cannot run.
- Close every tracked WebUI, including one already shutting down. Revoke API
  access before forcibly closing its sockets; pending request bodies cannot mutate.
- Wait for the owning workbench cleanup to release its lock, rather than clearing
  it blindly. Reject overlapping planning UI opens.
- Close tracked servers on shutdown and before restoring session/branch state,
  since returning terminal input makes navigation possible while the UI is open.
- Test Review/Selection, cancellation/no-op/Agent lock safety, incomplete requests,
  and the late-stream shutdown regression. Sync module contract and user/Agent docs.

Out of scope: reconnect grace, refresh behavior, frontend reconnection recovery,
collaborative editing, and release/version changes.

## Verification

- `npm run typecheck` and `npm run typecheck:contract`: passed.
- `npm test`: 80 node:test tests passed, plus WebUI DOM checks.
- Recovery tests cover both surfaces, opening-command return while locked,
  confirmation cancellation, Agent/TUI lock preservation, incomplete edit bodies,
  session isolation, branch teardown, and session shutdown.
- A pipelined close/liveness regression test verifies that closing cannot accept
  a new stream, and that an edit body finishing afterward cannot mutate the plan.
- Actual VS Code/SSH integration remains untested; framework input-loop behavior
  was verified against installed Pi `interactive-mode.js` and `agent-session.js`.
