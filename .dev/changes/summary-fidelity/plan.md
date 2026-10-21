# Summary fidelity

## Accepted scope

- Require four factual replacement sections in the model skill: goal/topic,
  actions/findings/outcome, important references, constraints/context.
- Keep important user expression in its original atoms by default. Compress it
  only with consent for that expression, and then quote it exactly with speaker,
  conditions, negations, exceptions, and scope intact.
- Require evidence over verdicts: distinguish proposed, attempted, changed, and
  verified; look up truncated originals instead of reconstructing quotes.

## Design

The change is confined to model-facing instructions. No tool action, parameter,
persisted field, or projection behavior changes, so the replacement text stays
exactly the summary the human approved and review metrics keep measuring what
commit will show.

## Steps

1. Rewrite the skill around the reporting contract: routing, direction,
   selection, replacement content, handoff checks, recall.
2. Synchronize the tool reference.
3. Update EN/zh-CN README.

## Verification

- `npm run typecheck` and `npm run typecheck:contract`: passed.
- `npm test`: 80/80 node tests passed; WebUI DOM checks passed.
- `npm run pack:check`: passed (30 files).
- Real small-model adherence to the template has not been benchmarked. The
  template constrains reporting, not semantic correctness.
