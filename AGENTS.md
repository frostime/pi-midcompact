# pi-midcompact

Branch-isolated mid-context compression for the Pi coding agent. The extension
freezes a session leaf (anchor), runs a planning transaction on a disposable
branch, and only writes committed compression into the session on explicit
human commit. See [README.md](./README.md) for the full design.

## Common commands

```bash
npm run typecheck          # typecheck extension code
npm run typecheck:contract # typecheck tests against the Pi APIs (tsconfig.test.json)
npm test                   # build mocks, run all 58 node:test suites
npm run pack:check         # npm pack dry-run (contents check)
```

## Repository layout

| Path | Role |
| --- | --- |
| `src/index.ts` | Extension entry: 1 tool, 8 `midcompact:*` commands, lifecycle hooks. |
| `src/` (others) | Domain modules: atoms/inventory/content-metrics, plan/selection, state, projection/telemetry, planning-lock, UI surfaces. |
| `src/SPEC.md` | Durable module contract. Update it with any contract change. |
| `skills/midcompact/` | Model-runtime skill shipped via `package.json` → `pi.skills`; keep in sync with tool/command behavior. |
| `.dev/changes/` | Workspaces of completed changes; history, not authority. |
| `.github/workflows/` | `ci.yml` tests; `publish.yml` publishes npm on any pushed `v*` tag. |

## Hard constraints

- **Tool contract**: the `midcompact` tool is a discriminated union on `action`
  (inspect/locate/plan/recall). Each action accepts only its own parameters;
  cross-action fields are rejected. The model-facing docs live in
  `skills/midcompact/references/tool-interface.md`.
- **Command naming**: slash commands are `midcompact:start|abort|commit|review|review-webui|select|select-webui|status` — the `name:sub` convention matches Pi's own `skill:<name>` commands. There is no bare `/midcompact`.
- **Persistence**: custom entries `midcompact-transaction`, `midcompact-draft`, `midcompact-state` on the session branch are the only persisted state. The planning lock is memory-only.
- **Human gate**: the agent proposes and drafts; only the user commits (`/midcompact:commit`). The tool never commits.
- **Releases**: bump `package.json` + `CHANGELOG.md`, then tag `v*` **on `main` only** — a pushed tag triggers `publish.yml` (npm publish). Never tag from a wip branch.
- **Commit messages**: Conventional Commits with emoji prefix; see the repo skill `git-commit-msg`. `CHANGELOG.md` follows Keep a Changelog; README is maintained in EN + zh-CN.

## Change workflow

Complex changes start on a `<type>/<slug>` branch with checkpoint commits; merge
back with `--no-ff`. One-off change artifacts (spec, plan, handover) go under
`.dev/changes/<slug>/` and are migrated into code/docs before closure.
