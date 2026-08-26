# Context Inventory And User-Directed Selection LAND

## 目的

本变更把 midcompact 的规划流程重组为三个明确阶段：先读取冻结锚点的全局分布，再确定压缩选择，最后为确定的连续范围撰写摘要。扩展负责事实统计和协议安全，用户负责范围取舍，Agent 负责语义摘要；已有 commit/abort、branch-local projection 和原文保留语义继续由现有模块拥有。

核心形状是：

```text
anchor snapshot
    -> context metrics
    -> inventory groups + cursor
    -> selection spans
    -> ordinary draft ranges
    -> summaries
    -> committed compression blocks
```

选择结果不新增“带洞 block”或特殊 projection 格式。KEEP 节点和 protected atom 只存在于选择阶段，最终统一展开成排序、无重叠、连续的普通 range。

## 目标代码树

```text
src/
├── index.ts                 modify, ~25-35%, major coordination change
│   └── owns tool dispatch, start mode selection, phase transitions,
│       Agent prompt sequencing, and commit/abort integration
├── types.ts                 modify, ~20-30%, shared contract change
│   └── defines metrics, inventory page, selection, transaction phase,
│       pending range, and compatibility fields; owns no rules
├── messages.ts              modify, ~10-20%, preserve existing rendering
│   └── keeps rendering, message keys, and tool-call helpers
├── atoms.ts                 modify, ~15-25%, preserve protocol grouping
│   └── owns protocol-safe atom construction and aggregation only
├── content-metrics.ts       create, +120-180, new leaf module
│   └── uniquely owns factual text/image metric rules for messages/parts
├── inventory.ts             create, +140-220, new aggregation module
│   └── owns user-group construction, totals, bounded pagination,
│       and serialization of inspect results
├── selection.ts             create, +100-160, new pure selection module
│   └── owns KEEP/protected subtraction and ordinary span expansion
├── plan.ts                  modify, ~20-30%, preserve range ownership
│   └── owns pending-to-summarized draft transitions and concise output
├── state.ts                 modify, ~20-30%, compatibility-sensitive
│   └── owns transaction phase, persisted Selection state, and
│       restoration of old state defaults
├── projection.ts            modify, ~10-20%, preserve message-key projection
│   └── owns factual replacement-size calculation and summary message
├── telemetry.ts             modify, ~30-45%, metric vocabulary change
│   └── owns Pi-reported usage presentation; no local token authority
├── renderers.ts             modify, ~15-25%, preserve entry rendering
│   └── owns state status using chars/images and Pi usage provenance
├── selection-ui.ts          create last, +180-260, TUI selection surface
│   └── owns user selection interaction only; no summary review behavior
├── review-ui.ts             modify last, ~10-20%, preserve review surface
│   └── owns summary/topic review only; no selection state machine
├── webui-server.ts          create last, +100-160, shared local Web transport
│   └── owns loopback server, route dispatch, and shared shell delivery
├── selection-webui.ts       create last, +100-180, Web selection adapter
│   └── owns selection endpoints and selection view state only
├── review-webui.ts          modify last, ~15-25%, Web review adapter
│   └── owns review endpoints and review view state only
└── review-webui.html        modify last, ~20-30%, shared Web shell
    └── routes `view=selection` and `view=review` to separate view controllers

test/
├── core.test.mjs            modify, ~20-30%, pure metrics/inventory/selection contracts
├── runtime.test.mjs         modify, ~30-40%, lifecycle and Agent/User mode integration
└── fixtures/                create if needed, small, image/message compatibility data

skills/
└── midcompact/SKILL.md      modify, ~30-50%, workflow protocol only
```

Selection and review are separate UI products. Selection creates or confirms Selection state; review edits summaries/topics and removes already-created ranges. They must not share a UI state machine or make one surface responsible for the other's lifecycle.

UI files are deliberately late consumers of the selection contract. They do not own selection semantics, range subtraction, persistence, or metric calculation.

The Web server and shell may be shared infrastructure, but the view route is explicit: `view=selection` and `view=review` use separate view adapters, callbacks, and client controllers. Reusing HTML structure must not merge selection and review behavior into one undifferentiated page.

## Ownership And Dependency Direction

### Fact metrics

`content-metrics.ts` is the single owner of factual message statistics. It may depend on the Pi image-dimension helper when available, but it must not depend on UI, draft, or transaction state. `messages.ts` keeps rendering, message keys, and tool-call helpers; `atoms.ts` consumes metric results while owning only protocol-safe grouping. `types.ts` defines shared structures but owns no metric rules.

The metrics layer distinguishes:

- text/content Unicode code points;
- image count, MIME, decoded payload bytes, optional dimensions;
- message and atom aggregation.

It never converts local character counts or image bytes into token claims. Pi-reported context window and usage remain external facts captured by `telemetry.ts`.

### Inventory

`inventory.ts` receives the frozen visible message/atom snapshot and returns immutable group/page data. It owns the first-user-message prefix group, user-message grouping, global totals, page size limits, and opaque cursor validation. `index.ts` only validates tool parameters and formats the tool result.

Inventory must not call `locate`, mutate draft, or read unprojected hidden history. Existing `buildAnchorSnapshot()` remains the source of the frozen visible stream.

### Selection

`selection.ts` is pure and operates on atom refs/indices plus a requested selection and KEEP set. A requested span may cross KEEP/protected atoms; the module subtracts those nodes and returns ordinary spans. It rejects only unknown/invalid input or a direct request to compress a protected atom. It does not create summaries, append session entries, or know whether the caller is TUI, Web, or Agent.

`plan.ts` converts returned spans into draft ranges. `index.ts` owns when those ranges are persisted and when the Agent is notified.

### Transaction and draft state

`state.ts` remains the persistence boundary. Transaction state gains mode and phase with backward-compatible defaults for old transactions. Selection state is persisted separately from DraftPlan and records the unconfirmed or confirmed user/Agent intent. Draft state can represent ranges whose boundaries are complete but whose summary is pending; committed compression state continues to contain only complete blocks.

The lifecycle is:

```text
transaction: selecting -> selection-confirmed -> summarizing -> ready_for_review
```

The selecting phase may be entered without an Agent message. Closing a UI does not change phase; abort and commit remain explicit user commands.

### Agent workflow

`index.ts` sends a short start message only for Agent propose mode. That flow must call inspect before locate/plan, persist the proposed Selection, and wait for an explicit user confirmation transition before materializing pending ranges. User select mode sends the Agent only confirmed range refs and factual metrics, then asks for summaries without allowing boundary expansion. Tool execution and state transitions enforce these rules; the skill is guidance, not the authority.

The skill documents this protocol but does not become a second owner of validation. Tool execution and state transitions enforce the hard rules.

### Projection and compatibility

`projection.ts` continues to replace exact `messageKeys` sequences and fail open when a sequence cannot be resolved. Existing approximate-token fields remain readable for old sessions but are not authoritative in new output. New factual character/image fields are additive and optional when restoring old state.

`renderers.ts`, `selection-ui.ts`, `review-ui.ts`, `selection-webui.ts`, `review-webui.ts`, and the shared Web shell consume the same metrics/state contracts; they do not derive independent totals. Selection UI owns Selection lifecycle; review UI owns review-draft editing.

## Review Boundaries

The following decisions are intentionally fixed before full implementation:

- grouping is by persisted User message, not historical runtime turn ID;
- inspect is bounded and paginated, with no message body or image base64 in its output;
- atom remains the compression boundary, including complete tool exchanges;
- Selection is separate from DraftPlan; only confirmed Selection materializes pending ranges;
- requested spans may cross KEEP/protected atoms, but final ranges never contain protected atoms;
- Agent boundary confirmation is an explicit runtime state transition;
- TUI and Web are consumers of one selection core;
- Pi usage is labelled as Pi-reported and local char/image facts are never presented as token estimates;
- UI work comes after metrics, inventory, selection, lifecycle, and Agent workflow contracts are executable.

The following remain local mechanics rather than architectural choices: final CLI mode flag spelling, cursor encoding, exact UI layout, image dimension failure text, and whether a later release adds KEEP-neighborhood shortcuts.
