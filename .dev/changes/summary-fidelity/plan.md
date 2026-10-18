# Summary fidelity and recorded file activity

## Accepted scope

- Require four factual replacement sections in the model skill, with exact quotations of important user instructions when their compression is explicitly authorized. Important user expression otherwise stays in original atoms.
- Add a code-owned, per-range file activity index from historical structured read/write/edit calls, including recorded codemode nested calls. Paths describe recorded calls, not verified outcomes or present filesystem state. No shell parsing, filesystem reads, generic tool log, or complete audit guarantee.
- Show the same index in plan reads, TUI Review, WebUI editor/projected view, and committed context. Include it in factual replacement metrics and live WebUI estimates. The index alone never makes a pending summary ready.

## Design

Store optional `fileActivity` on ranges and blocks, separately from editable summary. A focused module owns extraction and rendering; projection composes summary and index for all consumers. Derive once from selected frozen atoms when a range is created. Edits preserve it; commit copies it without re-extraction. Old v1 ranges/blocks without it remain unchanged (no silent backfill).

Alternative rejected: append generated text to editable `summary`; this would allow accidental deletion, repeated appending, and ambiguity between generated facts and authored conclusions.

No new tool action or parameter; no persistence version bump. Support only tools named read/write/edit with a nonempty string `path`, including recorded nested calls. Deduplicate/sort exact path strings per category; do not resolve or normalize against current cwd. Render paths as JSON string literals to preserve unusual characters.

## Steps

1. Register file activity vocabulary; strengthen SKILL.
2. Add extraction/rendering, optional persistence fields, shared replacement composition and measurements.
3. Expose read-only appendix across model/TUI/WebUI review and preserve through commit/reload.
4. Add behavior tests for scope, supported calls, failures, edits, projection, metrics, old state and UI rendering.
5. Update module contract and EN/zh-CN README. Run typechecks, tests and pack dry run; independent review.

## Verification

- Implemented steps 1–4 and synchronized `src/SPEC.md`, the tool reference and both READMEs.
- `npm run typecheck` and `npm run typecheck:contract`: passed.
- `npm test`: 84/84 node tests passed; WebUI DOM checks passed. Initial new test incorrectly checked endpoint previews for absent tool output; narrowed it to the replacement body, since plan reads intentionally show source endpoints.
- `npm run pack:check`: passed (31 files; includes `src/file-activity.ts`).
- Independent code review completed. Verified local dependency Pi 0.84.4 does not record nested calls, while installed Pi 1.1.0 does; clarified host-provided-record dependency in docs rather than raising the minimum version. Omitted nested arguments are ignored, not reconstructed.
- Review also noted `recall_list` has no overall character budget. This pre-existing behavior is unchanged; adding general recall pagination/truncation is outside this change.
- Real small-model summary quality has not been benchmarked; the template is guidance, not a semantic correctness guarantee.
