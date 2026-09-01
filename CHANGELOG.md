# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Browser workbench rework (`review-webui` / `select-webui`): decision strip with a post-commit projection band (display-level, `est.`-labeled, derived from a documented char-class assumption table), Raw ⇄ Projected timeline toggle, atom original-text drawer (`GET /api/atom/:ref`), pending-summary surfacing (list, projection card, close dialog), reviewed checklist, sticky editor actions, and next-step commit guidance. Selection is now two-state (unselected = KEEP) with keyboard selection (arrow keys / Space / G) and live range previews. Session-loss detection flips the page read-only.

### Changed

- Workbench visual system rebuilt: zinc-neutral surfaces with semantic-only color, 14px base type scale with relaxed density, timeline visual anchors (group rails, user landmarks, kind tints, size meters), light + dark themes, `prefers-reduced-motion` support.
- User-facing copy pass: "not compressible" → "can't compress"; internal jargon ("DraftPlan", "provider usage fact", "payload facts only") removed from the page.

## [0.5.3] - 2026-09-01

### Changed

- Wrapped the `midcompact` tool's parameters in a `request` field: the wire schema is now `{ request: <discriminated union> }` with a root `type: "object"`. Providers that validate tool schemas server-side (e.g. DeepSeek) reject a root-level `anyOf` before the model ever sees the request, which made every call fail there; the wrapper keeps the full branch structure visible to models while passing the root-object gate. Model-facing call shape changes from `{action, ...}` to `{request: {action, ...}}` (breaking); each branch is closed (`additionalProperties: false`) and uses single-value `enum` discriminants instead of `const` for provider portability.

## [0.5.2] - 2026-08-27

### Changed

- Grouped tool parameters by action as a discriminated union: `action` now selects the only parameter group that applies, so inspect/locate/plan/recall each expose just their own fields and cross-action parameters are rejected. The skill reference documents the per-action field lists. This is a breaking change to the model-facing tool contract.
- Split the composite `/midcompact <subcommand>` command into standalone slash commands `/midcompact:start`, `/midcompact:abort`, `/midcompact:commit`, `/midcompact:review`, `/midcompact:review-webui`, `/midcompact:select`, `/midcompact:select-webui`, `/midcompact:status` (`name:sub` follows the same convention as Pi's own `skill:<name>` commands). Each command carries its own description; the hand-written subcommand parsing is gone.

## [0.5.1] - 2026-08-24

### Changed

- `/midcompact start` now uses the standard `select` dialog for its three-way entry choice, identically in interactive and RPC mode. RPC carries it as an extension UI `select` message with a bounded 120s timeout; print/JSON modes still default to Agent direct.
- Agent direct is the first option (the default highlight, so Enter keeps the fast start path); an out-of-contract dialog answer is reported as an unrecognized choice instead of a silent cancel.

## [0.5.0] - 2026-08-22

### Added

- Added paginated, grouped context inventory with factual content-character and image metrics.
- Added read-only measurement of explicit, overlapping candidate spans before DraftPlan mutation.
- Added TUI and local browser Selection workbenches for creating ranges and preserving `KEEP` holes.
- Added Agent-direct and User-manual transaction entry flows with shared DraftPlan handoff.

### Changed

- Split boundary selection from summary/topic Review; Review now edits summaries, topics, and range membership while Selection edits boundaries.
- Made Agent-facing plan, inventory, and locate output semantic and bounded, with head/tail landmarks and match-centered search excerpts.
- Separated Pi-reported anchor usage from local factual content metrics instead of presenting local token-savings projections.

### Fixed

- Prevented concurrent Agent and UI DraftPlan edits with a runtime planning lock and closed stale browser workbench sessions when their liveness connection ends.
- Made User-manual handoff expose stored summaries and endpoints without assuming the shared selection is provisional.
- Rejected commits with pending summaries, invalid or overlapping ranges, or protected atoms.

[Unreleased]: https://github.com/frostime/pi-midcompact/compare/v0.5.3...HEAD
[0.5.3]: https://github.com/frostime/pi-midcompact/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/frostime/pi-midcompact/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/frostime/pi-midcompact/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/frostime/pi-midcompact/compare/v0.4.0...v0.5.0
