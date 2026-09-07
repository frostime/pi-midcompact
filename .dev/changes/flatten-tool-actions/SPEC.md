# flatten-tool-actions — Change SPEC

- **分支**: `refactor/flatten-tool-actions`
- **目标版本**: v0.7.0(wire breaking;发布 tag 仅在合并回 `main` 后打)
- **日期**: 2026-09-08
- **状态**: 设计已评审定稿(源自 2026-09-08 会话:误用案例分析 → schema 演化史梳理 → 组合空间审计 → 摊平可行性 → 词汇整顿)。实现未开始。

## 1. 问题陈述

用户在实际使用中观察到模型对 `midcompact` 工具的**高频误调用**:`{action:"plan", op:"show", detail:"full"}`(缺 `draft_id`)被运行时拒绝。围绕这一线索的系统性审计确认了三层问题:

1. **action 内部存在二级操作,字段合法性对 schema 不可见**。`plan` 的 `op`(show/add/update/remove)、`locate` 的 ref/过滤、`recall` 的列表/渲染、`inspect` 的 spans 有无——同一分支内"哪些字段组合合法"只能靠运行时与散文表达。后果是同类误用有两种不可预测的结局:有的硬拒绝(`show detail=full` 缺 `draft_id`),有的**静默忽略**(`plan update` 携带 `start/end` 时边界字段被丢弃,响应却报 "updated d1",模型基于错误信念继续规划——正确性隐患,不止是摩擦)。
2. **跨字段前置条件无法进入 schema**(如 `detail=full ⇒ draft_id`),而字段描述自 v0.5.3 一次成型后从未携带过这些耦合;约束只存在于 skill reference 文档中,模型未读即裸奔。
3. **契约词汇一名多义、同物多名**:`draft_id` 实为"plan 内某条 range 的 id"(草稿永远只有一份);`DraftPlan`/the draft/draft range 三个名字指同一对象;`span` 把函数参数抬升为实体;`ref` 一名横跨 a…/c…/g… 三个 id 空间;`detail` 在四个 action 上语义各异。

历史背景:该 schema 的演化(init → StringEnum → +inspect → union 分支 → request 信封)每次都由"调用整体失败"驱动(如 DeepSeek 400 拒绝 root-level anyOf);字段级语义误用因失败温和(单轮报错或静默忽略)从未触发结构性修复。本变更补上这最后一层。

**成功标准**:字段合法性尽可能由签名结构表达;工具中不存在"调用成功但字段被丢弃"的静默第三态;模型只需 5 个领域名词即可理解整个契约;所有文档同步可被 grep 机械验证。

## 2. 方案

**核心决策:把二级判别式与值模式全部摊平为顶层 union 分支(4 个 action → 11 个分支),每支字段闭合;同时把契约词汇收敛为 anchor / atom / plan / range / block 五个名词。**

- 摊平后,互斥、必填、字段归属、条件耦合全部成为签名结构;原"detail=full ⇒ ref"等耦合直接消失(不可再表达出违反)。
- 运行时仅保留两条"至少一个 of"规则(JSON Schema 受限子集确实无法表达)+ 分支闭合兜底(不信任 provider 调用时强制执行 `additionalProperties`)。
- `request` 信封保留(DeepSeek 等拒绝 root-level anyOf,历史已验证);判别式继续用单值 `StringEnum`(不用 `const`)。

**否决的替代方案**(决策依据):

| 替代方案 | 否决原因 |
|---|---|
| `pattern`/`tool_name`/`source` 合并为单一 `query` 字段 + 模式判别 | 语义过载:`source` 是枚举不是自由文本,"一个表示承载多个业务状态";且合取(AND)是锚点变大后唯一的换轴收窄手段,放弃是实际能力损失。**AND 语义保留** |
| 按 provider 适配多份 schema | pi 扩展只发一份 schema 给任意 provider,只能按最受限子集设计通用形态 |
| 保留 `plan` 单分支 + `op` 默认 show | 二级判别式正是静默忽略与耦合的根源;所有规范调用本就显式写 `op:"show"`,默认值无真实依赖 |
| `plan_show` 内用 if/then 表达 `detail=full ⇒ range_id` | 受限子集不支持 if/then;且 2×2 组合中 1 非法 1 退化,证明是两个操作挤在一个签名里——由 `plan_show`/`plan_read` 拆分取代 |
| 拆成多个 tool | pi 每次请求发送全部工具 schema,N 个 tool = N 份名字+描述的固定开销;且违背 SPEC "one midcompact tool" 与既有命令面 |

## 3. 行为契约

### 3.1 工具签名(11 分支,全部闭合 `additionalProperties: false`)

| action | 必填 | 可选 | 行为 / 预算 | 被结构消灭的旧约束 |
|---|---|---|---|---|
| `inspect` | — | `page_size`, `cursor` | 分页清单;默认 20 组、上限 50,超界静默钳制;分组行以 a… 区间为标签 | — |
| `measure` | `candidates`(≥1 项,`minItems:1`) | — | 测量候选区间,不改 plan;输出 12k 预算;语义同旧 `inspect spans` | spans+分页混用不可能;空数组 schema 拒绝 |
| `locate_ref` | `ref` | `detail`(brief 默认 / full) | 直查一个 atom;full = 全文(≤12k 截断) | ref+过滤互斥 ✓;`detail=full ⇒ ref` 由 ref 必填结构性保证 ✓ |
| `locate_search` | ≥1 过滤器(运行时规则 R1) | `pattern`, `tool_name`, `source`(user/assistant/tool_call/tool_result,**移除 "any"**), `direction`, `limit` | 合取(AND)过滤;≤3 条 + 总数与精化提示;`limit` 1..3 钳制;**无 `detail`**(全文走 `locate_ref`) | ref+过滤混合不可能;ref+direction/limit 静默忽略不可能;`source:"any"` 无操作值消失 |
| `plan_show` | —(**零字段**) | — | 全部 range 的 brief 清单 + 遥测头;12k 预算 | 二字段 2×2 矩阵(1 非法 1 退化)解体;最高频握手调用不可调错 |
| `plan_read` | `range_id` | — | 单 range 全文钻取 + 遥测头;40k 预算;未知 id → 报错 | `detail=full ⇒ range_id`(规则②,观察到的失败)结构性消灭;12k/40k 双预算与两操作一一对应 |
| `plan_add` | `start`, `end` | `summary`, `topic` | 缺省 summary = pending;拒绝条件不变(跨保护原子 / 重叠 / 逆序 / 未知 ref) | 缺 start/end → schema required;add 携带 `range_id`/`detail` 不可能 |
| `plan_update` | `range_id` | `summary`, `topic` | 运行时规则 R2:两者至少其一;**边界不可就地改,报错指明 remove+add 路径** | update 携带 `start/end` 静默忽略(最坏 bug)不可能;缺 `range_id` → schema |
| `plan_remove` | `range_id` | — | 移除一条 range | 携带杂字段不可能 |
| `recall_list` | — | `pattern`, `limit` | pattern 匹配 id/topic/summary(**不含正文**,描述需明示);limit 默认 8、1..20 钳制;免事务 | — |
| `recall_read` | `block`(c… id) | `detail`(brief / full) | 渲染块消息;12k / 40k 上限;截断标记不变 | ref+pattern/limit 静默忽略不可能;`detail` 语义局部化(一名三义消解) |

### 3.2 运行时合法性规则(全部剩余规则,必须带恢复路径的报错)

- **R1** `locate_search`:至少提供 `pattern`、`tool_name`、`source` 之一 → 否则报错并枚举三者。
- **R2** `plan_update`:`summary`/`topic` 至少其一 → 否则报错,文案含 *"boundaries change via plan_remove + plan_add"*。
- **兜底**:任何分支收到不属于该分支的字段 → 运行时报错(不静默),即使 provider 未在调用时执行 schema 校验。
- 其余皆为天然运行时域错误(未知 ref/range_id/block、跨保护原子、重叠、逆序),行为不变;关键报错文案的措辞对齐新词汇(如 `Unknown plan range d3.`),并附下一步建议(如 plan_read 前先 plan_show)。

### 3.3 不变式(本变更不触碰)

- 持久化:三种 entry(`midcompact-transaction` / `midcompact-draft` / `midcompact-state`)形状不变;`ranges[].id` 仍为 `d…`;无迁移。
- id 词汇:`a…`(atom ref)、`d…`(range id)、`c…`(block id)三个前缀不变;`g…` 从"地址空间"除名,降级为清单输出的显示标签(输出格式微调可选,文档重分类必须)。
- 命令面(8 个 `midcompact:*` 命令)、人工 commit 门、规划锁、recall 免事务、全部预算与钳制数值、locate_search 的 AND 合取语义——全部不变。
- 代码内部类型名(`DraftPlan` 等)为实现词汇,不改;本次只动契约面(参数名、判别值、文档)。

### 3.4 兼容性

- **Wire breaking**:模型调用形状从 `{action, op?, …}` 变为 11 个自描述分支。无持久化影响(工具调用不落盘),旧会话恢复不受影响。
- 运行时提示(index 内 state-specific 首动作指引)同步改为 `{action:"plan_show"}` 等新形状。

## 4. 实现决策

- schema 定义与 dispatch 重写集中于扩展入口;`plan`/`atoms`/`inventory` 等纯函数层签名基本不动,仅调用点适配分支类型。
- 字段描述全部重写并对齐新语义;描述与 skill reference 的同步是仓库既定约束。
- 文档同步清单(全部完成才算闭环):
  - `skills/midcompact/SKILL.md`(7 处 `request=` 示例 + 路由表 + 工作流措辞)
  - `skills/midcompact/references/tool-interface.md`(整体重构;"混用 action 需重发"等冲突修复散文大幅缩短)
  - `AGENTS.md`(Hard constraints 中工具契约一行)
  - `src/SPEC.md`(External contracts 一节)
  - `README.md`(如含调用形状示例)
  - `CHANGELOG.md`(0.7.0 条目,BREAKING 标注)
- 提交策略:分支上 checkpoint 提交(代码+测试一枚,文档同步一枚)→ `--no-ff` 合并 `main` → 仅在 `main` 上打 `v0.7.0` tag。

## 5. 验收标准

**可执行检查**:

1. `npm run typecheck` 与 `npm run typecheck:contract` 通过。
2. `npm test` 全部套件通过,其中:
   - 全部既有工具调用点(~26 处,集中在 runtime-agent/lock/user/transaction 套件)改写为新形状;
   - 新增断言:R1、R2 报错文案;越权字段运行时拒绝(以普通参数对象直调,确定性覆盖 provider 差异);`measure` 空 `candidates` 被拒;`plan_show` 零字段正常;`plan_read` 未知 `range_id` 报错。
3. 工具注册 schema 断言:11 个判别值、每支 `additionalProperties:false`、`candidates` `minItems:1`、判别式为单值 enum。
4. 文档同步 grep 门(应零命中,`CHANGELOG.md` 与 `.dev/` 历史除外):`draft_id`、`inspect_spans`、`op:"show"`、`spans`(作为工具参数名)。
5. `npm run pack:check` 通过。

**用户验证(open)**:

6. DeepSeek 冒烟:anyOf 分支数 4→11 机制未变但未实测,需在真实 DeepSeek 环境验证工具可注册、调用可达。[待验证——不阻塞合并,但发布前必须完成]

## 6. 术语表

| 术语 | 含义 |
|---|---|
| anchor | 冻结快照:事务开启时的会话历史只读视图,一切规划操作的背景 |
| atom | 原子:不可再分的选择单元(一次工具调用与其结果是一个原子);ref 形如 `a0001` |
| plan | 计划:每事务唯一的一份压缩提案(代码内名 DraftPlan),由若干 range 组成 |
| range | 区间:plan 的成员,一段连续 atom + 替换摘要(+可选 topic);id 形如 `d1` |
| block | 块:range 经人工 commit 后的永久形态;id 形如 `c0001`,recall 的对象 |
| measure | 度量:对候选区间做事实测量、不修改 plan 的操作(旧称 span inspection) |
| 分页机制 | `page_size`/`cursor`,通用 cursor-pagination,非领域概念 |
