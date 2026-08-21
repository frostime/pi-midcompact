# Context Inventory And Unified DraftPlan SPEC

状态：当前方案已确认。本文是本变更唯一有效的需求与行为契约；旧 LAND/PLAN 已归档，不再作为实现依据。

## Problem Statement

midcompact 当前要求 Agent 在长上下文中通过多次局部搜索建立全局认识、判断范围并撰写摘要。这会产生不必要的规划上下文开销，也让用户难以直接参与范围选择。

目标是把流程拆成两个输入端点、一个统一计划模型：

- Agent 可以通过工具创建和修改 DraftPlan；
- 用户可以通过 Selection UI 或 Review UI 创建和修改同一个 DraftPlan；
- 用户的选择只是初始提议，不是不可修改的边界；
- Agent 可以继续调整用户创建的 DraftPlan；
- 只有用户显式 commit 后，压缩才生效。

成功标准：Agent 能先看到低成本的全局 inventory；用户可以在 Agent 开始前编辑一个初始 DraftPlan；用户编辑结果能持久保存并被后续 Agent 发现；两种端点不会产生竞态；pending summary、协议边界和人工 commit 仍受到运行时保护。

## Terminology

- **锚点（anchor）**：运行 `/midcompact start` 时冻结的会话树叶节点。Inventory、atom refs 和 DraftPlan 都针对该快照。
- **Atom**：允许作为压缩边界的最小协议安全单元。包含工具调用的 Assistant 消息及其匹配的 tool result 属于同一个 `tool_exchange` atom。
- **用户分组**：从一条 User 消息对应的 atom 开始，到下一条 User 消息之前的顺序区段。第一条 User 消息前的内容属于前置分组。
- **Inventory**：冻结锚点的分页顺序统计，只返回范围和事实计数，不返回大段正文。
- **DraftPlan**：当前事务中的压缩计划，包含零个或多个 DraftRange。它可以由用户或 Agent 创建和修改，不能直接替代 commit。
- **Pending summary**：summary 为空的 DraftRange，表示范围已经进入计划但还没有摘要。
- **Review draft**：当前 DraftPlan 的用户审查状态。允许包含 pending summary，但不能 commit。
- **Content chars**：消息内容字段的 Unicode code point 数。它不是 provider 序列化后的字符数，也不是 token 数。
- **规划锁**：防止 Agent turn 与用户编辑 UI 同时修改 DraftPlan 的互斥状态。

## Approach

采用“inventory → 统一 DraftPlan → summary/review → commit”的流程：

1. `/midcompact start [instructions]` 保持现有入口。启动确认后，扩展在冻结锚点上提供一个小型选择：先让 Agent 开始，或先让用户编辑 DraftPlan。
2. Agent 和用户都通过各自端点操作同一个 DraftPlan。Selection UI 只是用户编辑 DraftPlan 的一种界面，不产生独立的 SelectionState。
3. User-first 模式保存 DraftPlan 后不自动启动 Agent。扩展通知用户，用户随后发送普通消息明确要求 Agent 继续；Agent 首先读取已有 DraftPlan，再决定是否 inspect/locate/add/update/remove。
4. DraftPlan 中 summary 可以为空。Review 可以打开 pending plan，但 commit 必须要求所有范围都有非空 summary。
5. Selection UI 和 Review UI 是独立界面，但共享 DraftPlan、metrics 和 mutation 规则。它们的区别是交互重点，不是底层数据模型。

## Behavior Contract

### 1. 真实统计

Inventory、DraftPlan、Review 和状态输出必须区分 Pi 数据与扩展统计。

Pi 数据：

- 当前模型上下文窗口上限，单位为 token；
- Pi 报告的当前 usage token 和比例；
- usage provenance，说明 Pi 数值可能包含 provider usage 与 trailing message 估算；
- Pi 无法提供时显示 unavailable，不得从字符数反推 token。

扩展统计：

- `content_chars`；
- message/atom/group 数量；
- image count、MIME、decoded payload bytes；
- 能够解析时的图片尺寸；
- protected/compressible atom 数量。

图片 base64 不计入 text chars，图片 payload bytes 不与 text chars 相加。扩展不得把本地字符换算伪装成 token savings 或 projected token usage。Skill 可以提供粗略 tokenizer 直觉，但不能把它作为工具结果中的事实。

### 2. Inventory

工具新增：

```json
{
  "action": "inspect",
  "limit": 20,
  "cursor": "..."
}
```

`inspect` 只读取活跃事务的冻结、projected visible snapshot，不创建或修改 DraftPlan。

每个分组至少返回：

- group ref；
- 起止 atom ref；
- message/atom count；
- content chars；
- 图片数量、payload bytes、MIME 摘要；
- protected/compressible 数量；
- User 消息短标签或前置分组标记。

默认最多 20 组，最大 50 组。返回全局 totals、当前页和不透明 next cursor。不得返回正文 preview、summary、工具输出或图片 base64。

### 3. Start 入口与模式选择

命令入口保持：

```text
/midcompact start [instructions]
```

不要求用户在命令文本中写 `--user` 或 `--agent`。

交互流程：

1. 等待 Pi idle；
2. 使用现有启动确认；
3. 冻结当前 anchor；
4. 提供两个模式选项：
   - `Agent first`：立即把规划交给 Agent；
   - `User first`：先打开用户 DraftPlan 编辑界面；
5. 模式选择取消时，不创建可见事务状态并返回原位置；
6. 选择完成后才持久化事务和空 DraftPlan。

无 UI 的模式保持 Agent-first 兼容行为。User-first 的 Web 入口可以由后续 selection Web UI 提供，但不改变 `/midcompact start` 的基本语法。

### 4. Agent-first

Agent-first 启动后发送短提示，要求 Agent：

1. 首先调用 `inspect`；
2. 通过 `plan` 创建或修改 DraftPlan；
3. 通过 `locate` 读取必要局部内容；
4. 为范围补 summary；
5. 停在用户 Review/commit 之前。

如果事务中已经存在 DraftPlan，例如用户先编辑后又要求 Agent 继续，Agent 必须先调用：

```json
{
  "action": "plan",
  "op": "show"
}
```

Agent 必须把已有 DraftPlan 视为当前初始计划，而不是假设事务从空计划开始。之后可以根据用户当前指令自由 add、update、remove 或补 summary。

如果用户消息与 midcompact 无关，Agent 不应仅因为事务存在就自动修改 DraftPlan。

### 5. User-first 与 Agent 交接

User-first 模式打开独立 Selection UI。用户可以：

- 按 group 或 atom 选择范围；
- 添加、删除和调整 DraftRange；
- 保留 KEEP atom；
- 查看字符、图片和 protected atom 事实；
- 为范围暂时留下空 summary；
- 保存并关闭；
- 放弃整个事务。

用户选择的大范围可以跨 KEEP/protected atom，但在写入 DraftPlan 前必须由统一 selection normalization 逻辑扣除并拆分为不含 protected atom 的连续 ranges。tool exchange 不能被拆开。

关闭 Selection UI 的语义是保存当前 DraftPlan，不是最终确认，也不是 commit。扩展不得自动发送 Agent turn。关闭后显示通知，例如：

```text
Draft saved. Tell the Agent to continue processing the current midcompact draft.
```

用户随后发送普通消息明确交接，例如：

```text
继续处理当前 midcompact draft。请先读取现有 plan，把它作为初始计划，必要时调整范围并补齐 summary。
```

Agent 收到交接消息后首先 `plan show`，因此能够知道启动时已经存在用户预选记录。

关闭 UI 只暂存；单独的 `/midcompact abort` 才放弃事务。

### 6. DraftPlan 与 Plan 操作

Agent 和用户操作同一个 DraftPlan。端点不同，但底层 mutation、边界校验和持久化路径必须相同。

Agent 工具 action：

- `inspect`：读取全局 inventory；
- `locate`：读取局部 atom；
- `plan/show`：读取当前 DraftPlan；
- `plan/add`：添加 range，summary 可为空；
- `plan/update`：更新 summary/topic；如需改变边界，可 remove 后 add；
- `plan/remove`：删除 range；
- `recall`：读取已提交 block 的原始内容。

不保留 `action="select"` 或 `action="confirm"`。用户 UI 的选择不是 Agent 工具中的另一种计划对象。

Plan mutation 输出必须有界：显示 revision、range refs、字符/图片统计和 pending 状态，不回显 summary 或长 preview。完整 summary 只在 Review UI 或显式完整 plan 查询中展示。

### 7. Review

Review UI 与 Selection UI 分离，但面对同一个 DraftPlan。

Selection UI 重点是：

- inventory 时间线；
- 范围创建、边界编辑和 KEEP；
- 初始 DraftPlan 保存。

Review UI 重点是：

- 查看当前全部 DraftRange；
- 编辑 summary/topic；
- 增删或调整 range；
- 查看 pending、字符、图片和 protected 状态；
- 最终确认是否 commit。

Review 允许 pending summary。以下条件满足前不能 commit：

- 每个 range 都有非空 summary；
- range 不重叠；
- range 不包含 protected atom；
- range 边界和 message key 仍能解析；
- DraftPlan 至少包含一个可提交 range。

用户可以在 Agent 修改后重新打开 Selection UI 或 Review UI。没有必要在第一版记录用户初始 plan 与 Agent 当前 plan 的差异审计。

### 8. 并发与规划锁

Agent turn 与用户编辑 DraftPlan 不能并发：

- Agent turn 运行时，打开 Selection/Review UI 的操作被拒绝并 notify 用户；
- Selection/Review UI 打开时，Agent 不得修改 DraftPlan；
- UI 保存并关闭后释放规划锁；
- 普通 inspect/locate 读取不修改 DraftPlan，可按实现决定是否允许在 UI 打开时调用。

建议在 Agent 正在运行时直接拒绝打开 UI，而不是静默等待，避免用户误以为自己已经获得编辑权。

### 9. 图片与召回

图片不得被 text renderer、inventory 或 recall 静默遗漏：

- 图片存在不会自动使 atom protected；
- 选中图片范围时显示图片数量和 payload bytes；
- summary 应保留后续工作所需的图片语义；需要视觉原文时由用户保留对应 atom；
- 普通 recall 返回图片占位元数据，不默认注入图片 base64；
- 原始 session entry 中的图片 payload 不被 midcompact 改写或删除。

第一版不要求精确图片 token 估算、按图片重新注入模型或恢复原始文件名。

### 10. Commit、abort 与分支隔离

- commit 只能由用户命令执行；
- commit 返回 anchor 并写入 branch-local compression state；
- abort 返回 anchor 且不改变 active compression state；
- 原始 session entries 保留；
- 精确 message sequence 无法解析时 fail open；
- 已提交 compressed blocks 在后续事务中保持 protected。

## Implementation Decisions

### Unified DraftPlan

`DraftPlan` 是用户和 Agent 的唯一计划模型。`DraftRange.summary` 可为空，空值表示 pending summary。Selection UI 的选择结果通过统一 normalization 直接写入 DraftPlan，不持久化 SelectionState。

现有 checkpoint 中新增的 `SelectionState`、`SELECTION_ENTRY`、`action="select"`、`action="confirm"` 和 `selection-confirmed` phase 属于临时实现，不是目标契约，应在后续收敛中移除。

### Shared mutation

创建一个由 Agent tool 和 UI callback 共用的 DraftPlan mutation 边界。它负责：

- range 创建、更新、删除；
- protected/protocol 校验；
- selection normalization；
- revision 增加；
- DRAFT_ENTRY 持久化。

`types.ts` 只定义类型；`content-metrics.ts` 唯一拥有统计规则；`messages.ts` 负责 rendering/message key/tool-call helpers；`atoms.ts` 负责协议安全分组和聚合；`state.ts` 负责 transaction 和 DraftPlan 持久化。

### Agent awareness of existing user plan

User-first 保存后不向模型自动发送隐藏消息。下一条用户交接消息触发 Agent 后，skill 和启动上下文必须要求 Agent 先 `plan show`。这样 Agent 能发现 DraftPlan 已经由用户建立，并把它作为初始输入。

### UI separation

Selection UI 和 Review UI 保持不同界面与操作重点，但共享 DraftPlan 和 mutation contract。Web 可以共享 server/shell，通过 `view=selection` 与 `view=review` 路由使用不同 controller；不共享 SelectionState。

## Compatibility And Non-Goals

兼容要求：

- 已发布 v1 compression state 继续恢复、投影和 recall；
- 现有 locate、plan、recall 基本用途继续可用；
- `/midcompact start [instructions]` 入口保持兼容；
- Agent 仍不能 commit；
- TUI/Web 只是 DraftPlan 的不同操作端点。

当前 checkpoint 中尚未发布的 Selection/confirm 状态不构成长期兼容契约，可以重构或删除。

第一版不要求：

- 精确 provider tokenizer；
- 按模型计算每组 token；
- 图片 token 估算；
- 历史运行时 turn ID 恢复；
- 压缩单个 tool exchange 内部的一部分；
- 带洞 compression block；
- SelectionState 审计；
- 用户初始 plan 与 Agent 当前 plan 的 diff 历史；
- 自动启动 Agent；
- `/midcompact confirm`。

## Acceptance Criteria

### Start And Handoff

- `/midcompact start [instructions]` 入口不要求 mode flags。
- 启动确认后，交互模式显示 Agent-first/User-first 两个选项。
- Agent-first 立即发送 Agent workflow prompt。
- User-first 打开 Selection UI，且在用户关闭保存前不启动模型。
- User-first 关闭后保存 DraftPlan、释放 UI、给用户显示继续交接提示，不自动创建 Agent turn。
- 用户下一条明确交接消息触发 Agent 后，Agent 第一个相关工具调用是 `plan show`，并能发现已有用户 DraftPlan。

### Inventory And Plan

- inventory 分页有界，返回字符和图片事实，不返回正文或 base64。
- Agent 和 UI 对同一个 DraftPlan 的增删改使用一致的边界校验和 revision。
- `plan/add` 允许空 summary；`plan/show` 能显示 pending 状态。
- `action="select"`、`action="confirm"` 和 `/midcompact confirm` 不存在于目标接口。

### Review And Safety

- Review UI 可以打开 pending DraftPlan。
- pending summary、protected atom、重叠范围、无效 message sequence 都阻止 commit。
- 用户和 Agent 不能并发修改 DraftPlan；Agent turn 运行时打开编辑 UI 会被拒绝并 notify。
- Selection UI 与 Review UI 是独立界面，但对同一 DraftPlan 工作。
- commit 仍只能由用户执行，abort、tree rollback、重复事务和 fail-open projection 行为不回归。

### Verification

- metrics、inventory、DraftPlan mutation、selection normalization、画像、状态恢复和 runtime workflow 测试通过；
- `npm run typecheck`；
- `npm test`；
- `npm run typecheck:contract`；
- `npm run pack:check`。
