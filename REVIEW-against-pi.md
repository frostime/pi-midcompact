# pi-midcompact 对照审查文档（基于真实 Pi 源码，供独立验证）

> 本文档供外部审查者（如在线 ChatGPT / 人工 reviewer）**独立核对**使用。
> 文档记录：审查所依据的 Pi 版本与源码定位、审查对象的设计与实现摘要、以及逐条列出的**疏漏**。
> 每条疏漏给出：原型代码位置、Pi 侧源码证据、影响分析、需要验证的问题。
> 文档刻意**不包含任何修改建议**，仅陈述事实与待验证点。

---

## 0. 文档目的与使用方法

- 审查对象：`pi-midcompact` 原型项目（branch-aware mid-context compression，Pi coding agent 扩展）。
- 审查目标：验证该扩展的**设计假设与实现**与 Pi 官方源码/生命周期是否吻合，找出疏漏。
- 建议的独立验证路径：clone 上游仓库 `https://github.com/earendil-works/pi-mono`，按第 1 节定位源码文件，逐条核对第 4 节的证据链；涉及运行时行为的问题按第 5 节给出"源码可确认 / 需实机测试 / 文档已说明"的判定。

---

## 1. 对照基准：Pi 版本与源码定位

### 1.1 本地安装环境（审查实际读取的产物）

| 包 | 版本 | 本地路径 |
|---|---|---|
| `@earendil-works/pi-coding-agent` | **0.84.1** | `D:/AppData/npm/node_modules/@earendil-works/pi-coding-agent/`（含 `docs/` 与 `dist/`） |
| `@earendil-works/pi-agent-core` | **0.84.1** | 同上 `node_modules/@earendil-works/pi-agent-core/` |
| `@earendil-works/pi-ai` | **0.84.1** | 同上 `node_modules/@earendil-works/pi-ai/` |

- 上游仓库：`https://github.com/earendil-works/pi-mono`（compaction 文档中的源码链接指向 `packages/coding-agent/src/...`）。
- `dist` 编译产物与源码的对应关系已通过 sourcemap（`*.js.map` 的 `sources` 字段）确认：

| dist 产物 | 对应上游源码 |
|---|---|
| `dist/core/extensions/types.d.ts` | `packages/coding-agent/src/core/extensions/types.ts` |
| `dist/core/extensions/runner.js` | `packages/coding-agent/src/core/extensions/runner.ts` |
| `dist/core/extensions/wrapper.js` | `packages/coding-agent/src/core/extensions/wrapper.ts` |
| `dist/core/tools/tool-definition-wrapper.js` | `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts` |
| `dist/core/session-manager.js` / `.d.ts` | `packages/coding-agent/src/core/session-manager.ts` |
| `dist/core/messages.js` | `packages/coding-agent/src/core/messages.ts` |
| `dist/core/sdk.js` | `packages/coding-agent/src/core/sdk.ts` |
| `dist/core/agent-session.js` | `packages/coding-agent/src/core/agent-session.ts` |
| `dist/core/agent-session-runtime.js` | `packages/coding-agent/src/core/agent-session-runtime.ts` |
| `dist/main.js` | `packages/coding-agent/src/main.ts` |
| （pi-agent-core）`dist/agent-loop.js` | `packages/agent-core/src/agent-loop.ts` |

> ⚠️ 版本口径注意：pi-midcompact 的 `package.json` 中 devDependencies 声明 `^0.80.6`、peerDependencies 为 `"*"`，而本机实际安装为 0.84.1。**本文档所有"已确认"结论均以 0.84.1 为基准**；0.80.6 与 0.84.1 之间的 API 差异**未核对**（见疏漏 C）。外部审查者在 GitHub 上核对时，请同时确认所对照的 tag/commit 与哪个 npm 版本对应。

### 1.2 已核对过的官方文档（`packages/coding-agent/docs/`）

- `extensions.md`：生命周期图（session_start → … → context → turn_end → agent_end → agent_settled；/tree → session_tree）、`context` 事件说明、`ctx.isIdle()/abort()/waitForIdle()`、`ExtensionCommandContext` 的会话控制方法、`navigateTree`、`agent_end` 后可能仍 auto-retry/auto-compact 的说明。
- `session-format.md`：entry 类型（`custom` 条目不参与 LLM context；`custom_message` 参与）、SessionManager 方法（`appendCustomEntry`、`getBranch(fromId?)` 等）。
- `compaction.md`：原生压缩机制（cut point、`firstKeptEntryId`、`CompactionEntry`）。
- `packages.md`：`pi install /absolute/path/to/package` 命令存在。

---

## 2. 审查对象：pi-midcompact 项目摘要

### 2.1 项目文件（共约 1235 行）

```
src/index.ts       318 行   扩展入口：命令、工具、事件钩子、commit 流程
src/types.ts       111 行   消息/原子/压缩块/草稿类型
src/atoms.ts       152 行   协议原子构建与定位
src/messages.ts    116 行   messageKey 指纹、文本渲染、token 估算
src/plan.ts         87 行   草稿区间增删改
src/projection.ts   61 行   请求时投影（原始区间 → summary 消息）
src/state.ts        64 行   分支状态存取（midcompact-state / transaction / draft 条目）
skills/midcompact/SKILL.md  38 行
test/core.test.mjs       137 行   纯逻辑测试（原子、投影、状态）
test/runtime.test.mjs    142 行   端到端测试（FakePi/FakeSessionManager/FakeCtx）
test/install-mocks.mjs    9 行    安装 mock 模块
dev/pi-shims.d.ts   全部声明为 any 的类型垫片
```

### 2.2 核心设计（一句话版）

- 用户在干净时间点执行 `/midcompact` → 记录锚点（当前 leaf）→ 追加 `midcompact-transaction` / `midcompact-draft` custom 条目 + 一条引导 user 消息，形成**维护分支**；
- Agent 用 `midcompact` 工具（`locate`/`plan`/`commit`/`recall`）在冻结锚点快照上规划压缩区间；
- `commit`：`ctx.ui.confirm` 人审 → 置 `pendingCommit` → `turn_end` 中 `ctx.abort()` → `agent_end` 后 `setTimeout` 异步执行：`waitForIdle` 轮询 → **`navigateTree(锚点, {summarize:false})`** → `pi.appendEntry("midcompact-state", 新状态)`；
- `context` 钩子：把 `activeState` 中各 block 的原始消息序列（按 `messageKey` 指纹子序列匹配）**替换**为一条 `role:"custom", customType:"midcompact-summary"` 的摘要消息；指纹失配则 fail-open 保留原文；
- 状态按分支恢复（`session_start`/`session_tree` → `restoreRuntime`），`/tree` 回滚到 commit 之前 ⇒ 投影消失、原文恢复。

### 2.3 关键代码摘录（疏漏引用用）

**commit 流程**（`src/index.ts:165-211`，行号按当前文件）：

```ts
// 工具 execute 内（ctx: ExtensionContext）：
const approved = await ctx.ui.confirm("Apply midcompact plan?", preview);   // :170
if (!approved) return toolResult("Commit cancelled ...");
const nextState = mergeDraftIntoState(snapshot.anchorState, draft);
pendingCommit = { ctx, transaction, draft, nextState };                      // :173 ← 捕获工具 ctx

// turn_end：if (pendingCommit) ctx.abort();                                // :184

// agent_end：
setTimeout(async () => {
  await waitForIdle(work.ctx);                                              // :193 ← 轮询 ctx.isIdle()（上限 200×25ms=5s）
  ...
  await work.ctx.navigateTree(work.transaction.anchorEntryId, { summarize: false });  // :197
  pi.appendEntry(STATE_ENTRY, work.nextState);                              // :198
  ...
}, 0);
```

**waitForIdle 轮询**（`src/index.ts:312-318`）：`for (i<200) { if (ctx.isIdle()) return; await sleep(25); } throw new Error("Agent did not become idle...")`。

**指纹**（`src/messages.ts:37-44`）：

```ts
export function messageKey(message: MessageLike): string {
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : 0;
  return `${message.role}:${timestamp}:${fnv1a64(stableStringify(message))}`;
}
```

**锚点快照**（`src/index.ts:231-238`）：

```ts
const built = buildSessionContext(entries, tx.anchorEntryId, byId);   // 官方 API，compaction-aware
const anchorBranch = sm.getBranch(tx.anchorEntryId);
const anchorState = restoreCompressionState(anchorBranch);
const visibleMessages = projectMessages(built.messages, anchorState);
return { atoms: buildAtoms(visibleMessages, anchorBranch), anchorState };
```

**测试环境**（`test/runtime.test.mjs:60-79`）：`FakeCtx` 手写了 `ui.confirm / isIdle / abort / navigateTree`；`FakePi` 提供 `on / registerCommand / registerTool / appendEntry / sendUserMessage / emit`；`test/install-mocks.mjs` 把 `test/mocks/pi-ai`、`test/mocks/pi-coding-agent`（两个几乎为空的假包）复制进 `.test-dist/node_modules`；`dev/pi-shims.d.ts` 把两个官方包声明为 `any`。测试 8/8 通过。

---

## 3. 已确认与 Pi 吻合的部分（附证据，供复核）

以下为逐条对照 0.84.1 源码后**成立**的设计前提：

| # | 原型假设 | 0.84.1 源码证据 | 结论 |
|---|---|---|---|
| 1 | `pi.on("context")` 返回 `{messages}` 可改写请求消息 | `main.ts` → `createAgentSessionFromServices`（agent-session-services.ts）→ `createAgentSession`（sdk.ts:66）→ `transformContext`（sdk.ts:219-224）→ `runner.emitContext`（runner.ts `emitContext`，按扩展加载顺序链式处理，每个 handler 的返回喂给下一个）；随后 `convertToLlm`（core/messages.ts）把 `role:"custom"` 转为 user 消息 | ✅ 投影消息能到达 provider |
| 2 | `pi.appendEntry(customType, data)` 存在 | ExtensionAPI 定义（types.ts，`appendEntry<T>(customType, data?)`） | ✅ |
| 3 | custom 条目不进入 LLM 上下文 | `sessionEntryToContextMessages`（session-manager.ts）：仅 message/custom_message/branch_summary/compaction 产生上下文消息 | ✅ 状态条目对 LLM 透明 |
| 4 | `buildSessionContext(entries, leafId?, byId?)` → `{messages,...}` | session-manager.ts 导出，compaction-aware（`buildContextEntries`） | ✅ |
| 5 | `sm.getEntries()/getBranch(fromId?)/getLeafId()` 在工具/事件 ctx 可用 | `ctx.sessionManager` 类型为 `ReadonlySessionManager`（types.ts:219；session-manager.d.ts:140） | ✅ |
| 6 | `ctx.ui.confirm/notify`、`ctx.abort()`、`ctx.isIdle()` 在 ExtensionContext 可用 | types.ts ExtensionContext；runner.ts createContext | ✅ |
| 7 | `ctx.waitForIdle()`、`ctx.navigateTree(targetId,{summarize})` 存在 | 均为 `ExtensionCommandContext` 方法（types.ts:275；runner.ts createCommandContext；agent-session.d.ts navigateTree 选项含 `summarize`） | ⚠️ 存在，但**仅命令上下文**（→ 疏漏 A） |
| 8 | 事件名与语义：session_start / session_tree / turn_end / agent_end / agent_settled | agent-session.ts `_emitExtensionEvent`；agent-session-runtime.ts | ✅ |
| 9 | `pi install <绝对路径>` 安装方式 | docs/packages.md 明确支持 | ✅ |
| 10 | `Type`/`Static` 从 `@earendil-works/pi-ai` 导入 | pi-ai 重导出 typebox：`export { Type } from "typebox"` | ✅ |

---

## 4. 疏漏清单

### A. 【致命】commit 提交路径调用了仅命令上下文才存在的 API —— 在真实运行时必然抛错

**原型位置**：`src/index.ts:173`（把工具 execute 的 `ctx: ExtensionContext` 存入 `pendingCommit`）、`:197`（`work.ctx.navigateTree(...)`）。

**Pi 侧证据链（0.84.1）**：

1. `ToolDefinition.execute` 的 ctx 参数类型是 `ExtensionContext`（types.ts:371：`execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext)`）。
2. `navigateTree`（以及 `waitForIdle`）**只**挂在 `ExtensionCommandContext` 上：types.ts:275（`ExtensionCommandContext` 内）；runner.ts `createCommandContext()` 才挂载 `context.navigateTree`（runner.js:559-563）。
3. 扩展工具在运行时被包装为：`agent-session.ts:1983` `wrapRegisteredTools(allCustomTools, runner)` → `wrapRegisteredTool`（extensions/wrapper.ts）→ execute 的 ctx 缺省值来自 `runner.createContext()`（wrapper.ts 注释原文："Uses the runner's createContext() for consistent context across tools and event handlers"）。
4. pi-agent-core `agent-loop.ts` 调用工具时**不传 ctx**：`prepared.tool.execute(prepared.toolCall.id, prepared.args, signal, (partialResult) => {...})` → 必然回退到 `createContext()`。
5. `createContext()`（runner.ts:459 起）不包含 `navigateTree`/`waitForIdle`。

**影响**：commit 批准后，`agent_end` 回调中 `work.ctx.navigateTree(...)` 抛 `TypeError: work.ctx.navigateTree is not a function`，被 `try/catch` 捕获并 notify "Midcompact commit failed"。即：**locate/plan/recall 可用，但事务闭环的"导航回锚点 + 落盘状态"步骤永远无法完成**。该缺陷被测试体系掩盖（见疏漏 B）。

**需要验证的问题**：
- ① 0.80.6 中工具执行上下文是否同样不含 `navigateTree`（对照 `packages/coding-agent/src/core/extensions/types.ts` 的 0.80.6 版本）；
- ② 是否存在官方未文档化的途径，让扩展在非命令上下文修改 leaf（例如 `SessionManager.branch()` 是否被暴露在工具可见的任何接口上）；
- ③ `ExtensionRunner` 是否有任何"延迟命令执行"机制可供工具/事件回调使用。

### B. 【高】测试与类型检查体系与真实运行时完全脱节

**原型位置**：`dev/pi-shims.d.ts`（两个官方包全部声明为 `any`）；`test/mocks/`（两个近乎空的假包）；`test/runtime.test.mjs` 的 `FakeCtx`（手写 `navigateTree`、`isIdle`、`confirm`、`abort`）。

**影响**：
- `tsc` 类型检查在 shims 下**无法**发现任何对官方 API 的误用（疏漏 A 即为典型）；
- 运行测试用假包 + FakeCtx，`FakeCtx.navigateTree` 直接修改 `sm.leafId`，完全绕开了真实 runner 的上下文构造逻辑；
- 项目从未在真实 Pi 运行时中安装执行过（无任何集成测试记录）。

**需要验证的问题**：把 `dev/pi-shims.d.ts` 替换为真实 `@earendil-works/pi-coding-agent` / `pi-ai` 类型后，`tsc --noEmit` 是否报错、报哪些错（预期应报 `navigateTree` 不存在于 `ExtensionContext`）。

### C. 【高】版本漂移：声明依赖 ^0.80.6，实际对照 0.84.1，差异未核对

**原型位置**：`package.json`（devDependencies `^0.80.6`；peerDependencies `"*"`）。

**影响**：本文档"已确认"结论基于 0.84.1；0.80.6 与 0.84.1 之间以下 API 是否变化**未知**：
- `ToolDefinition.execute` 的 ctx 类型；
- `navigateTree`/`waitForIdle` 在上下文接口中的归属；
- `context` 事件链路（`transformContext` → `emitContext`）是否存在于 0.80.6；
- `ReadonlySessionManager` 成员、`buildSessionContext` 签名；
- `custom` 角色消息经 `convertToLlm` 的行为。

**需要验证的问题**：在 pi-mono 中对比 0.80.6 与 0.84.1 对应 tag 的上述文件（`git log --oneline <tag80>..<tag84> -- packages/coding-agent/src/core/extensions/types.ts` 等），确认每项结论是否跨版本成立。

### D. 【中】提交时序与生命周期假设未验证

**D1 `turn_end → ctx.abort()`**（`src/index.ts:184`）
- 工具返回终态后 turn 自然结束，`turn_end` 中调用 `ctx.abort()` 中止"当前 agent 操作"。
- 待验证：① turn_end 触发时 run 是否已实质结束，abort 是否为 no-op；② abort 是否可能中断 toolResult 消息的持久化或 `agent_end` 的触发；③ 官方对 abort 在 turn 末尾调用的语义说明。

**D2 `agent_end` 后 `setTimeout(0)` 异步提交 + 5 秒 idle 轮询上限**（`src/index.ts:191-196, 312-318`）
- 官方文档明确 `agent_end` 后 Pi 仍可能 auto-retry / auto-compact / 执行 queued follow-up（"agent_end fires when that run ends, but Pi may still auto-retry, auto-compact and retry, or continue with queued follow-up messages"）。
- 待验证：① agent_end 与真正 idle 之间（尤其 auto-compaction 触发时）的典型耗时是否可能超过 5 秒轮询上限，导致 commit 失败；② `agent_settled` 与 `isIdle()` 的关系（`agent_settled` 文档称 `ctx.isIdle()` 为 true，但原型用的是 `agent_end`）。

**D3 会话替换/重载期间模块级 `pendingCommit` 生命周期**（`src/index.ts:78`）
- `pendingCommit` / `commitScheduled` 为模块级单例；`/new`、`/resume`、`/reload`、`/fork` 会触发 `session_shutdown` → `session_start`。
- 待验证：① 旧 runner 被标记 stale（runner.ts `assertActive` / `staleMessage`）后，captured ctx 调用是否抛错、异常是否被原型 catch 并降级为 notify；② 新会话中 `agent_end` 是否还会触发该 setTimeout 回调；③ `session_shutdown` 未清理 `pendingCommit` 是否造成跨会话误提交风险。

**D4 commit 导航与 `session_tree` 恢复的时序依赖**（`src/index.ts:197-198`）
- `navigateTree` 会触发 `session_tree` → `restoreRuntime`（重置 transaction/draft/activeState），随后才 `appendEntry(STATE_ENTRY)`（appendEntry 不触发事件，activeState 手动覆盖）。
- 待验证：官方 `navigateTree` 实现中 `session_tree` 事件是否同步发出、`appendEntry` 是否触发任何事件；若顺序/同步性假设不成立，内存态与分支态会不一致。

### E. 【中】上下文投影的机制性假设

**E1 指纹稳定性**（`src/messages.ts:37-44`）
- 锚点快照与请求时投影两侧的消息都源自 `buildSessionContext`，但 `context` 事件的消息要经过 `structuredClone` 深拷贝（runner.ts `emitContext`）。
- 待验证（需实机抓包/打点）：`context` 事件中的消息对象与 `buildSessionContext` 输出是否**逐字段一致**，特别是：① 消息是否都带数值型 `timestamp`；② `thinking` 内容是否在 context 事件时已存在（而非 provider 序列化时才剥离）；③ `toolCall.arguments`、`toolResult` 字段、`bashExecution` 字段是否原样保留；④ 是否存在任何规范化（如 `content: null → []`）使两侧指纹失配。任一失配 ⇒ 投影 fail-open（安全但失效）或锚点原子不可压。
- 另注意：`mapEntryIds`（messages.ts:99-115）按指纹把消息映射到 entryId，同指纹消息按顺序队列配对——与 E1 同源风险。

**E2 context 钩子顺序耦合**（已证实的机制，属设计风险）
- `emitContext` 按扩展加载顺序链式传递，每个 handler 的输出是下一个的输入；任何第三方 context 扩展先行改写消息都会破坏指纹匹配；midcompact 的投影结果也可能被后续扩展再次改写。README 已自述该限制。

**E3 投影 summary 消息的转换路径**（`src/projection.ts:8-25`）
- 投影消息 `role:"custom", customType:"midcompact-summary", display:true` 需经 `convertToLlm` 转成 user 消息才能发送；已验证转换函数存在（core/messages.ts），但**未实机验证**：① 转换发生在 context 事件之后、provider 序列化之前（agent-loop.ts `streamAssistantResponse` 顺序：transformContext → convertToLlm → streamFunction）；② 转换后 `details.blockId`、`display` 等字段是否被保留/剥离；③ 部分 provider 的序列化器对多段 text content 的处理。

**E4 与原生 `/compact` 的相互作用**
- 已确认：`buildSessionContext` 是 compaction-aware，锚点快照中已被原生压缩的中段表现为 `compactionSummary` 消息 ⇒ 被 `buildAtoms` 归类为不可压原子（fail-closed，保守正确）。
- 未验证：① 事务进行期间发生 auto-compaction（compaction entry 追加在维护分支上）对锚点祖先链与后续投影的影响；② commit 之后原生压缩覆盖了某 block 的消息范围 ⇒ 该 block 指纹永不匹配、永久 inert，但状态与 recall 仍保留该 block——此组合行为无测试；③ 两次压缩机制并存时上下文重复计费/双摘要的观感。

**E5 多 commit 的状态累积与回滚**
- `restoreCompressionState` 取分支上最后一个 `midcompact-state` 条目；每次 commit 追加新条目且 block 累积（`mergeDraftIntoState` 复制旧 blocks）。
- 语义自洽，但需验证：多次 commit 后 `/tree` 回滚到较早位置 ⇒ 祖先中较早的 state 条目生效 ⇒ 较新的 blocks 失效——是否符合"树版本化"预期，且与新块相关的原始消息在回滚后的投影中不会出现残留替换。

### F. 【中低】边界与交互行为（未文档化 / 未测试）

- **F1 工具执行中 await `ctx.ui.confirm`**（`src/index.ts:170`）：在 agent turn 进行中弹出模态确认框。待验证：交互模式下工具执行内 UI 对话框的实际可用性、对 agent 阻塞/超时/取消的语义；print/RPC 模式下 `confirm` 为 no-op（返回 undefined ⇒ 恒取消），非交互模式 commit 永远不可达——文档未说明。
- **F2 事务期间用户 `/tree` 导航**：`restoreRuntime` 从新分支重建内存态；导航到不含 TXN 条目的分支 ⇒ 工具报 "No active midcompact transaction"（fail-closed 但用户无提示如何恢复）；导航回维护分支内部 ⇒ 事务复活。行为未文档化。
- **F3 孤儿维护分支**：commit 用 `{summarize:false}` 离开维护分支，维护对话永久留存于 session 文件（磁盘增长、`/tree` 可见、无清理机制）。
- **F4 重启恢复未完成事务**：`session_start → restoreTransaction` 可恢复事务与草稿，但 `/midcompact` 命令的"已有事务"判定基于内存态；重启后需先 `status` 或直接依赖工具/skill——端到端链路无测试。
- **F5 会话切换时模块级单例状态**：`activeState/transaction/draft/pendingCommit` 均为模块级；`session_shutdown` 无清理逻辑；同一进程多会话场景（RPC 多会话、会话切换）下的状态交叉污染边界未处理。

### G. 原型自述的限制（README/DESIGN 已列出，供完整性核对）

- 原生 `/compact` 互操作未定稿；
- 原子构建保守，缺 provider 级集成测试（尤其并行/多工具消息）；
- 投影定位器与第三方 `context` 转换器排序不兼容（fail-open）；
- 无 Web 评审 UI（评审在维护对话 + 最终交互确认）；
- locator 为确定性文本/工具名匹配，非嵌入；
- 已压缩块视为受保护原子，不支持嵌套再压缩；
- token 估算为字符数/4 的粗糙启发式。

---

## 5. 给独立验证者的核对清单

1. **定位源码**：clone `https://github.com/earendil-works/pi-mono`，确认第 1.1 节的文件对应关系与 tag（0.84.1；如需对照 0.80.6 则找对应 tag/commit）。
2. **核对疏漏 A（最高优先）**：按第 4 节 A 的 5 条证据逐一核对源码（types.ts 的 execute 签名与 ExtensionCommandContext；runner.ts 的 createContext/createCommandContext；wrapper.ts 的 ctx 工厂；agent-core agent-loop.ts 的 execute 调用处；agent-session.ts 的 wrapRegisteredTools）。
3. **核对疏漏 B**：将 shims 换成真实类型后 tsc 是否报错。
4. **核对疏漏 C**：diff 0.80.6 ↔ 0.84.1 的相关文件。
5. **判定其余项**：对 D/E/F 的每个问题给出结论类别：`源码可确认` / `需实机测试` / `文档已说明`，并附证据位置。
6. **输出**：逐条给出"确认 / 反驳 / 无法判定"，注明依据的 commit hash 与行号。

---

*文档基准：pi-coding-agent / pi-agent-core / pi-ai 0.84.1（npm 全局安装），pi-mono 源码路径见第 1 节；pi-midcompact 代码为审查时当前工作区版本。*
