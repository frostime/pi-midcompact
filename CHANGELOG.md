# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/frostime/pi-midcompact/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/frostime/pi-midcompact/compare/v0.4.0...v0.5.0
