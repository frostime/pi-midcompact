# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[Unreleased]: https://github.com/frostime/pi-midcompact/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/frostime/pi-midcompact/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/frostime/pi-midcompact/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/frostime/pi-midcompact/compare/v0.4.0...v0.5.0
