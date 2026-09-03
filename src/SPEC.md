# SPEC — midcompact extension module (`src/`)

Maintenance contract for `src/`. The model-facing usage contract lives in
`skills/midcompact/` (SKILL.md + references/tool-interface.md) and is
authoritative for observable tool/command behavior; this spec records the
durable invariants a future maintainer must preserve, which are not reliably
inferable from code at a glance. Entry point: `src/index.ts` (factory in
package.json → `pi.extensions`).

## Persistence

- Exactly three custom entry types are ever persisted on the session branch:
  `midcompact-transaction`, `midcompact-draft`, `midcompact-state`
  (`state.ts`). All are `version: 1`, shape-checked before use.
- Restore is *latest entry wins* over the branch. A draft restores only when
  a transaction entry precedes it with a matching `transactionId`; the two
  form one unit. State entries are independent of transactions.
- Commit appends a new state entry — never mutates old ones. Abort writes
  nothing.
- Compatibility is a standing constraint: old transactions without
  `startMode` default to `"agent"`; old ranges lacking factual char/image
  fields are coerced (`coerceDraftRange`). Legacy `approxTokens` fields are
  deprecated: never authoritative for decisions or UI.
- The planning lock is deliberately not persisted: reload clears the owner.

## Transactions

- Start freezes the current leaf as anchor, appends TXN + DRAFT, and routes
  Agent-direct or User-manual. All planning happens on the child branch; the
  discussion never enters the working context.
- Commit and abort both navigate back to the anchor (`navigateTree`); commit
  then appends state, abort appends nothing. Both refuse to run while the
  Agent holds the planning lock.
- `anchorUsage` is informational only — Pi-reported awareness, never an
  optimization target. The web workbench may additionally render a
  **display-level** post-commit projection derived from the documented
  char-class assumption table in `content-metrics` (`TOKEN_ESTIMATE`): always
  labeled `est.`, shown as a propagated band, and never feeding commit
  gating, range validation, or any decision (same rule as `projectedTokens`
  / `approxTokens`).
- Atom refs are transaction-local: re-run inspect/locate in a later
  transaction; group refs (`g...`) are never locate refs.

## Projection

- While blocks are active, the context hook replaces committed blocks with
  their summary wrapper. The original history is restored only by recall;
  recall never re-projects. Committed blocks appear as protected atoms in
  later snapshots (no double compression).

## Atoms and ranges

- The atom is the smallest selectable unit; a tool call plus its matching
  results is one indivisible `tool_exchange` atom.
- Protected (never compressible): incomplete/orphaned tool protocol,
  existing compressed blocks, unsupported message kinds, entries lacking
  the persistent anchor entry.
- Draft ranges never overlap and never contain protected atoms; boundaries
  cannot be updated in place (remove + re-add). Empty `summary` = pending;
  commit rejects pending, reversed, overlapping, or protected-crossing
  ranges. `KEEP` is expressed by leaving atoms outside all ranges.

## Concurrency

- One runtime mutex over DraftPlan edits: owner ∈ {agent, ui}. Agent turns
  hold it for their whole lifetime (`agent_start` → `agent_settled`); UIs
  hold it per session via the `midcompactPlanningLock` API object (exposed
  for UI and tests).
- Blocked operations notify and return — there is no queue.

## External contracts (reference, don't duplicate)

- Tool: one `midcompact` tool whose parameters are `{ request: <union> }` —
  a root `type: "object"` wrapping a discriminated union on `action`
  (inspect/locate/plan/recall); each branch is closed
  (`additionalProperties: false`), so cross-action parameters are
  schema-rejected. The `request` wrapper exists because some providers
  (e.g. DeepSeek) reject a root-level `anyOf` before the model sees the
  schema.
  Details: `skills/midcompact/references/tool-interface.md`.
- Commands: `midcompact:start|abort|commit|review|review-webui|select|select-webui|status`;
  no composite `/midcompact`; native naming convention `name:sub` (Pi's
  `skill:<name>`).
- The tool never starts a transaction and never commits; both are command-
  or user-gated. Recall is the only action valid without a transaction.
- Web workbench (`review-webui.html` + `review-webui.ts`): the state payload
  carries per-atom char-class counts (`narrowChars`/`wideChars`), per-range
  replacement char-class counts (including the actual wrapper), and the
  assumption table (`est`), so the page renders the projection band and can
  update estimates while a summary is edited; `GET /api/atom/:ref` serves the
  frozen atom's full text for the original-text drawer (read-only, snapshot-local).
  User-facing copy says "can't compress" for protected atoms; "protected"
  stays the agent/tool-side term.
  Page invariants that broke once and must hold: the `<!--MIDCOMPACT_STATE-->`
  script tag is the server's template injection point (renaming it breaks
  state loading); `selectionRefs` initialization depends on helpers defined
  later in the page script (order is load-bearing, TDZ); `gbody` visibility
  is driven by the render-time `hidden` attribute, so collapse handlers must
  sync that attribute, not just a class.

## Change rules

- Adding a tool action → new request branch + handler type + tool-interface
  section + SKILL.md routing; adding parameters to an action → its branch
  only (the union stays nested under `request`).
- Changing persistence shapes → keep `version: 1` readable (coerce) or add
  a migration; restore predicates (`state.ts`) are the compatibility gate.
- Renaming commands → update SKILL.md/README/tests together; the stale-name
  failure mode is a doc-arbitrated contract violation.
- Test seams: `setOpenReviewWebBrowser` and the mocks in `test/` must stay
  behavior-faithful to the real extension API; suites drive commands via
  `pi.commands.get(...)` and the tool via plain param objects.