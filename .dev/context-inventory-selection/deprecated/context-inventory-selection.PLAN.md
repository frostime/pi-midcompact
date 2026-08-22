# Context Inventory And User-Directed Selection PLAN

关联文档：

- `context-inventory-selection.SPEC.md`：需求与行为契约
- `context-inventory-selection.LAND.md`：目标代码形态、边界和依赖方向

执行原则：先完成事实统计、纯逻辑和持久化状态，再接 Agent 工作流，最后才实现 TUI/Web UI。每个阶段结束后先运行验证，再进入下一阶段。

## Phase 1: Compatibility Baseline

- [ ] 固化现有 `CompressionState`、`TransactionState`、`DraftPlan` 的恢复样例，覆盖旧 v1 state、旧 transaction、旧 draft。
- [ ] 在 `test/core.test.mjs` 保留 projection、atom protocol、range overlap、fail-open 的行为测试。
- [ ] 在 `test/runtime.test.mjs` 保留 start、commit、abort、tree rollback、重复事务和 recall 的端到端测试。
- [ ] 增加图片消息 fixture，确保测试 harness 能保存 flat `{ type: "image", data, mimeType }` content part。

**Agent Check**

- `npm run typecheck`
- `npm test`
- 现有行为测试全部通过；尚未改变用户可见流程。

## Phase 2: Factual Content Metrics

- [ ] 创建 `src/content-metrics.ts`，定义消息级、图片级和聚合级事实统计接口。
- [ ] 实现 text/thinking/tool-call/tool-result/bash/custom 内容的 `content_chars` 统计。
- [ ] 实现 image count、MIME、decoded payload bytes 和可选尺寸读取；图片 base64 不进入 text chars。
- [ ] 修改 `src/messages.ts` 的内容遍历，使 image part 不再被静默忽略；保留现有 rendered text 兼容用途。
- [ ] 修改 `src/atoms.ts`，为 atom 汇总 message count、content chars、image facts，同时保持 tool exchange 为完整压缩边界。
- [ ] 为中英文、代码、工具参数、工具结果、bash、custom message 和图片增加纯逻辑测试。

**Agent Check**

- 统计结果可由 fixture 手工复算。
- 相同消息重复统计得到相同结果。
- 图片数量和 payload bytes 正确，图片不会被计入 text chars。

## Phase 3: Inventory Core And Inspect Tool

- [ ] 创建 `src/inventory.ts`，按 frozen visible atom stream 构建前置分组和 User-message 分组。
- [ ] 为每个 group 生成当前事务锚点内稳定的 group ref、atom span、消息/atom 数量、字符和图片统计。
- [ ] 实现全局 totals、默认 20、最大 50 的分页限制和不透明 cursor。
- [ ] 确保 inventory 不输出 preview、summary、工具正文和 image base64。
- [ ] 在 `src/types.ts` 增加 inventory group/page/query/result 类型。
- [ ] 在 `src/index.ts` 的工具 schema 增加 `action="inspect"`、page size 和 cursor 参数。
- [ ] 将 inspect 连接到 `buildAnchorSnapshot()`，只读取冻结锚点的 projected visible messages。
- [ ] 输出 Pi-reported context window/usage/provenance；Pi usage 不可用时显示 unavailable，不从字符反推 token。
- [ ] 增加 inspect unit/runtime tests，覆盖分页、前置分组、图片统计、protected atom 和重复调用稳定性。

**Agent Check**

- `inspect` 一页有固定上限，结果无正文转储。
- 继续使用 cursor 可以完整遍历分组且不重复、不遗漏。
- inspect 不改变 draft、transaction 或 active compression state。

## Phase 4: Factual Telemetry And Draft Output Migration

- [ ] 修改 `src/telemetry.ts`，把 Pi usage 与扩展事实统计分开建模和格式化。
- [ ] 修改 `src/types.ts`、`src/plan.ts` 和 `src/projection.ts`，增加 range/block 的真实字符、图片和 replacement message 字符字段。
- [ ] 计算 replacement content chars 时基于实际 summary message 包装文本，而不是固定 `+40` token。
- [ ] 保留旧 approximate-token 字段的读取能力，旧 state 无迁移即可恢复；新输出不把它们作为权威指标。
- [ ] 修改 `src/renderers.ts` 和文本 status/commit notice，移除 estimated token savings/projected token percentage 的对外展示。
- [ ] 增加回归断言：plan mutation 不回显 summary，也不回显长 preview。

**Agent Check**

- 新 draft、review data、commit state 使用真实 chars/images 字段。
- 旧 state fixture 仍可 restore、project 和 recall。
- grep 检查 Agent-facing 输出不再生成本地 estimated token savings。

## Phase 5: Selection Core And Pending Draft

- [ ] 创建 `src/selection.ts`，实现 requested atom span 减 KEEP/protected atom 的统一展开算法。
- [ ] 允许 requested span 跨过 KEEP/protected atom；只有单独要求压缩 protected atom 时拒绝。
- [ ] 拒绝 unknown ref、reversed span、empty span 和非法选择；最终输出不得包含 protected atom。
- [ ] 合并相邻可压缩片段，输出排序且无重叠的连续 spans。
- [ ] 在 `src/types.ts` 增加独立 Selection、Selection confirmation 和 pending range 状态类型。
- [ ] 修改 `src/plan.ts`，允许边界已确定但 summary 为空的 range，并提供补摘要、删除、验证路径；Selection 不直接视为 DraftPlan。
- [ ] 修改 commit validation，拒绝 pending summary、无效边界、重叠范围和 protected atom。
- [ ] 增加 selection unit tests：整段选择、KEEP 洞、protected 洞、相邻片段合并、tool exchange 不可拆分。

**Agent Check**

- 同一 selection input 在不同调用方得到完全相同的普通 ranges。
- 选择结果不包含带洞 range 或 protected atom。
- 未确认 Selection 不会 materialize 为 pending draft；pending draft 永远不能 commit。

## Phase 6: Transaction Lifecycle And Agent Workflow

- [ ] 修改 `TransactionState`，增加 `mode`：Agent propose/User select；增加 `phase`：selecting/selection-confirmed/summarizing/ready for review。
- [ ] 增加独立的 persisted Selection state/entry，记录候选或用户选择、KEEP refs、确认状态和锚点 revision；不要把未确认 Selection 伪装成 DraftPlan。
- [ ] 修改 `state.ts` 的 restore/validation，为旧 transaction 提供兼容默认值，并恢复未确认 Selection 和已确认后中断的 pending ranges。
- [ ] 修改 `/midcompact start`：先冻结 anchor、写入 transaction/Selection/空 draft，再决定模式；Agent 模式才发送规划消息。
- [ ] 无显式模式时保持旧 Agent-first；User select 通过显式模式入口或简单 `ui.select` 进入 selecting，不依赖完整 review UI。
- [ ] 在工具层增加独立的 Selection mutation action，用于 Agent 持久化候选 Selection；不得用 `plan add` 代替 Selection。
- [ ] 增加明确的 `/midcompact confirm` 用户命令或等价扩展状态操作；它只确认当前 Selection，不直接 commit。
- [ ] 修改 Agent prompt：先 inspect，后形成并持久化 Selection，等待确认后才 locate/plan/materialize pending ranges；不得自行 commit。
- [ ] 增加 User select 完成后的 Agent prompt，只发送已确认 range refs、字符/图片事实和用户 focus，不发送完整会话。
- [ ] 在工具执行层拒绝 selecting 阶段的 `plan add`、未经确认的范围 materialization，以及 User select 对已确认边界的修改；Selection mutation、confirm 和 summary update 使用各自的状态规则。
- [ ] 修改 `session_start`、`session_tree` 和 status 恢复逻辑，使 transaction mode、Selection 和 phase 可恢复。
- [ ] 更新 `skills/midcompact/SKILL.md`：固定 inventory-first、Selection/pending/review draft 语义、显式确认、用户范围所有权、事实统计口径、图片保留和语义守恒规则。

**Agent Check**

- Agent 模式首次规划调用为 inspect，而不是 locate 或 plan。
- 未经用户确认 Selection，Agent 不能 materialize pending ranges 或创建 plan range。
- User select 模式在 Selection 确认前不产生 Agent 消息。
- selecting 阶段调用 `plan add` 被运行时拒绝。
- reload/tree navigation 后 transaction mode、Selection、phase 和 draft 一致恢复。

## Phase 7: Non-UI Selection Integration

- [ ] 提供不依赖 TUI 的 Selection state mutation API，接收 group/atom selection 和 KEEP refs，调用 `selection.ts` 展开普通 ranges。
- [ ] 提供显式 Selection 确认/取消/恢复路径，使 Agent propose 和 User select 都通过同一状态转换。
- [ ] 将已确认 Selection 生成的普通 spans 持久化为 pending draft，并进入 summarizing phase。
- [ ] 用 runtime fake 验证 User select 的完整非 UI 生命周期：start → selection → confirm → pending draft → summarize → review/commit。
- [ ] 用 runtime fake 验证 Agent propose：inspect → persist proposal → explicit user confirm → materialize → summarize。
- [ ] 验证 Agent/User 两种模式共享同一 selection core、confirmation guard 和 draft persistence。

**Agent Check**

- 非 UI 测试可以生成、确认、取消和恢复 Selection，不需要浏览器或 TUI。
- 未确认 Selection 不可 commit，也不会产生 pending range。
- commit/abort/tree rollback 行为与旧流程一致。

## Phase 8: TUI Selection Surface (Last)

- [ ] 创建 `src/selection-ui.ts`，实现独立的 selecting overlay；不得把 selecting mode 加入 `src/review-ui.ts`。
- [ ] 按 inventory group 展示顺序统计和 atom 标记。
- [ ] 支持选择整个 group、连续 atom span、切换 KEEP、展开/收起 tool exchange 展示。
- [ ] 显示 content chars、image facts、protected/compressible 标记和自动拆分后的普通 ranges。
- [ ] 复用 Phase 7 的 selection mutation API，不在 UI 中复制范围拆分规则。
- [ ] 选择确认后关闭 selection overlay，进入 summarizing phase；关闭不等于 abort。
- [ ] 增加 TUI runtime fake 和 selection 行为测试。
- [ ] 保持 `src/review-ui.ts` 的 summary/topic review 语义独立；只在必要处接入已确认的 phase。

**Agent Check**

- TUI 选择 KEEP 洞后生成的 ranges 与纯逻辑测试一致。
- 选择前不发送模型消息。
- TUI selection 的关闭、确认、abort 状态转换可区分。
- review TUI 不会出现 selection 的选择状态或 KEEP 编辑控件。

**User Check**

1. 启动 User select。
2. 选择一个大分组并保留其中一个关键 atom。
3. 确认后检查自动拆出的多个范围和字符/图片统计。
4. 关闭 selection 后，再单独打开 review 完成 summary 编辑和 commit。

## Phase 9: Web Selection Surface And View Routing (Last)

- [ ] 创建 `src/webui-server.ts`，抽取 loopback server、生命周期、公共响应和 view route dispatch。
- [ ] 创建 `src/selection-webui.ts`，只提供 selection view 的 API：选择 group/span、切换 KEEP、确认和取消。
- [ ] 保持 `src/review-webui.ts` 只提供 review view 的 API：编辑 summary/topic、删除 range、关闭 review。
- [ ] Web 路由使用明确的 view suffix/query，例如 `?view=selection` 与 `?view=review`；两个 view 使用不同的 controller、callbacks 和页面状态。
- [ ] `src/review-webui.html` 可以继续作为共享 shell，但只能根据 view 路由加载对应的 selection/review controller；不得把两套操作混成一个状态机。
- [ ] Web 请求只调用共享 selection mutation API；不得在浏览器端自行判断 protected atom 或拆分范围。
- [ ] 页面刷新通过 `/api/state?view=selection|review` 恢复对应 phase、Selection/draft 和最新事实统计。
- [ ] 非 TUI 环境显式选择 User select 时打开 selection view；review 命令打开 review view；不得静默回退为另一种 view。
- [ ] 增加 Web serialization/API tests，验证 selection view 与 TUI/纯逻辑产生相同 ranges，review view 不改变 Selection。

**Agent Check**

- Web selection view 选择同一输入得到与 TUI 相同的普通 ranges。
- 页面刷新不丢失对应 view 的状态。
- selection view 与 review view 的 API 和操作集合互不越界。
- Web UI API 不传输会话正文或图片 base64；selection/review 输出保持有界。

**User Check**

1. 在无 TUI 模式启动 User select，确认浏览器打开 selection view。
2. 在 selection view 中选择和保留关键 atom，确认 Selection。
3. 刷新 selection view，确认选择仍在。
4. 关闭 selection view 后打开 review view，完成 summary review 和 commit。

## Phase 10: Integration, Documentation And Packaging

- [ ] 更新 `README.md` 和 `README.zh-CN.md`，说明 inspect、两种规划模式、字符/图片统计和 UI 流程。
- [ ] 更新命令补全和工具描述，确保 Agent 能发现 inspect 与模式入口。
- [ ] 增加完整端到端场景：Agent propose、User select TUI、User select Web、图片范围、旧 state、reload、abort、commit、重复事务。
- [ ] 检查所有 Agent-facing 输出：无本地 token 伪估算、无重复 summary、无不必要正文回显。
- [ ] 删除所有临时 shape markers；检查实现与 LAND 的文件树、所有权和依赖方向一致。

**Agent Check**

- `npm run typecheck`
- `npm test`
- `npm run typecheck:contract`
- `npm run pack:check`
- `rg "estimated.*token|saved.*token|projected.*token" src skills test` 结果仅保留兼容字段/内部说明，不出现在新的 Agent-facing 格式中。

**User Check**

- 用户可以先用 inspect 看到全局分布，再选择 Agent propose 或 User select。
- 用户选择范围时能清楚看到字符数、图片和 protected atom。
- Agent 不会在用户确认范围前自行 plan。
- commit 后只保留摘要和 KEEP 原文，原始图片/消息仍可从 session history 保留。
