# Context Inventory And User-Directed Selection SPEC

状态：需求与总体方案已确认；实现细节可在不改变行为契约的前提下调整。

## Problem Statement

midcompact 当前要求 Agent 在已经较长的上下文中，通过多次 `locate` 自行建立全局认识、判断压缩范围并创建草案。这个流程存在三个问题：

1. Agent 缺少整个冻结上下文的顺序分布和体量概览，只能依赖已有注意力或反复搜索局部内容。规划过程因此可能产生大量临时对话和工具结果，进一步占用本就紧张的上下文。
2. 范围选择本质上包含用户偏好。Agent 可以提出建议，但不应是唯一的选择者；用户需要能够直接查看上下文分布并手动划定压缩区段、KEEP 节点和保留洞。
3. 当前统计把字符数换算成近似 token 并对外展示，容易产生伪精确感；图片还会被文本统计遗漏。扩展应提供可验证的字符、图片和 Pi usage 数据，不应把本地启发式估算伪装成 token 事实。

成功标准是：冻结锚点后，Agent 和用户都能先看到低成本、分页的全局分布；用户可以选择由 Agent 提案或自己划分范围；Agent 只在必要时读取局部细节并为确定的范围撰写摘要；整个流程不破坏工具协议、分支隔离、人工提交和原文召回能力。

## Terminology

- **锚点（anchor）**：运行 `/midcompact start` 时冻结的会话树叶节点。所有 inventory、atom ref 和范围选择都针对该快照。
- **Atom**：允许作为压缩边界的最小协议安全单元。一个包含工具调用的 Assistant 消息及其紧随的匹配工具结果属于同一个 `tool_exchange` atom。
- **用户分组（user-led group）**：从一条 User 消息对应的 atom 开始，到下一条 User 消息之前为止的顺序区段。第一条 User 消息之前的可见内容进入单独的前置分组。
- **Inventory**：冻结锚点的分页顺序统计。它只提供范围、字符、图片和可压缩性等事实，不返回大段原文。
- **手动选择模式（User select）**：用户在 TUI 或本地 Web UI 中直接选择压缩范围和 KEEP 节点，Agent 随后只负责撰写摘要。
- **Agent 提案模式（Agent propose）**：Agent 先读取 inventory，再向用户提出候选范围；用户确认后才创建或修改草案。
- **选择意图（Selection）**：用户或 Agent 提出的待压缩 atom spans 与 KEEP 节点。它可编辑、可持久化、不可直接 commit，不等同于正式 draft。
- **待摘要范围（pending range）**：Selection 经用户确认后展开得到的连续普通 range，等待 Agent 写入非空 summary。
- **审查草案（review draft）**：所有 pending range 都已获得非空 summary、可以进入用户 review 的 DraftPlan。
- **字符数（content chars）**：可见消息中实际内容字段的 Unicode code point 数。它不是 provider 请求序列化后的字符数，也不是 token 数。

## Approach

采用“先建立分布，再选择范围，最后撰写摘要”的三阶段流程：

1. **Inventory 阶段**：扩展在冻结锚点上计算按用户消息分组的全局顺序统计。Agent 或用户可以低成本了解主要体量分布、图片分布、protected atom 和可压缩范围。
2. **Selection 阶段**：用户或 Agent 产生可编辑但不可提交的选择意图；用户确认后，扩展把它展开为连续普通 pending ranges。
3. **Summary 阶段**：Agent 只对已确认的 pending ranges 撰写摘要；所有范围完成后形成 review draft，用户审查并显式 commit。

范围选择最终仍展开为现有的连续普通 ranges。带洞范围、排除节点和 protected atom 都由选择层自动拆分，不引入一种新的“带洞压缩块”持久化格式。

## Behavior Contract

### 1. Inventory 数据真实性

Inventory 必须区分 Pi 提供的数据和扩展直接统计的数据。

Pi 数据：

- 当前锚点使用的上下文窗口上限，单位为 token；
- 锚点启动时 Pi 报告的 usage token 数和占用比例；
- 若可用，可额外显示当前规划分支的 Pi usage，且必须与锚点 usage 分开标识；
- 所有 usage 都标注为“Pi reported”。界面和工具说明必须指出：Pi 的数值可能由最近一次 provider usage 加后续消息估算组成，并非扩展重新精确 tokenize 的结果；
- Pi 返回空值时显示 unavailable，不允许根据字符数补算。

扩展统计：

- `content_chars`：消息内容字段的 Unicode code point 数；
- `message_count`；
- `atom_count`；
- `image_count`；
- `image_payload_bytes`：base64 解码后的实际 payload 字节数；
- 图片 MIME 类型；
- 图片尺寸在能够可靠读取时显示，读取失败不影响 inventory；
- protected 和 compressible atom 数量。

字符统计不得包含图片 base64 字符串，不得把图片 payload 字节数加到文本字符数中，也不得把任何本地字符换算结果标成 token。

Inventory、plan 工具输出、TUI/Web review、状态提示和 commit 通知中，不再把 `字符数 / 4` 或其他本地启发式结果作为预计 token、预计节省 token 或预计提交后占用比例展示。

Skill 可以提供一条简短的非权威直觉，例如英文通常约 3–4 个 ASCII 字符对应一个 token、中文通常约 1–2 个汉字对应一个 token、代码差异较大。该说明必须明确依赖模型和 tokenizer，不能用于生成伪精确数值；图片不得按 payload 大小换算 token。

### 2. Inventory 分组与分页

midcompact 工具新增 `action="inspect"`。该 action 只在活跃事务中读取冻结锚点，接受有界页大小和上一页返回的不透明游标；不接受正文搜索条件，也不创建或修改 draft。

第一版固定按 User 消息划分，不尝试恢复未持久化的运行时 turn ID，也不增加通用的 `group_by` 抽象。

每个用户分组至少显示：

- 稳定于当前事务锚点的 group ref；
- 起止 atom ref；
- atom 和消息数量；
- content chars；
- 图片数量、payload 字节数和 MIME 摘要；
- protected/compressible atom 数量；
- 发起该分组的 User 消息短标签；
- 若为第一条 User 消息前的内容，明确标为前置分组。

Inventory 按会话顺序返回，并支持有界分页。每页返回全局总计、当前页分组和不透明的下一页游标。默认页大小应足以形成宏观认识，但工具结果必须有固定上限；第一版默认 20 组，最大 50 组。

Inventory 不返回 atom preview、summary、工具输出正文或图片 base64。Agent 需要具体内容时，再对少量边界或节点调用 `locate`。

Inventory 统计的是冻结锚点经过当前 midcompact 投影后实际可见的上下文。已有 compressed summary 作为 protected atom 参与统计；其已经隐藏的原始块不计入当前上下文分布。

### 3. 启动与模式选择

`/midcompact start` 必须先冻结锚点，再进行模式选择。不得先在可继续增长的当前会话上保存可执行的 atom ref 或范围选择。

交互环境中的默认启动流程：

1. 用户确认启动事务；
2. 扩展保存锚点 usage、空 Selection 和空草案；
3. 若命令没有显式模式，保持现有 Agent-first 行为；若用户使用显式 User select 入口，进入 selecting 阶段；
4. User select 的模式选择可以使用简单的 `ui.select` 或显式命令参数，不依赖完整 review UI；
5. 只有 Agent 模式完成用户确认，或者 User select 完成选择确认后需要生成摘要时，扩展才发送消息触发模型。

命令应提供显式参数，使用户能够跳过模式选择并直接进入 Agent 或手动模式。现有 `/midcompact start [instructions]` 的 Agent 规划用途保持兼容；精确 CLI 拼写可在实现时确定，但不能把普通 focus 文本误解析为模式参数。

在没有原生 TUI 的模式中，Agent 模式仍可使用；显式手动模式使用本地 Web UI。不得因为没有 TUI 而静默回退为 Agent 自主选择。

事务外可以提供只读 inventory 预览，但它不能产生可提交选择，也不能承诺 atom ref 在后续 start 后仍有效。第一版不要求实现事务外预览。

### 4. Agent 提案模式

启动提示和 midcompact skill 必须约束 Agent 的调用顺序：

1. 首先调用一次 inventory，建立全局分布；
2. 基于字符、图片、protected atom 和工作阶段提出少量候选分组；
3. 在用户确认范围或压缩深度之前，不调用 `plan add`；
4. 用户确认后，仅对候选边界和关键节点进行少量 `locate`；
5. 创建普通 ranges 并撰写摘要；
6. 要求用户 review，Agent仍不能 commit。

Agent 不应从无目标的关键词搜索开始，也不应为了遍历会话而分页读取所有 inventory。只有当第一页无法覆盖候选旧阶段或用户要求更广范围时才继续翻页。

Agent 提案必须先形成可持久化的 Selection，而不是直接写入 DraftPlan。用户通过明确的确认命令或等价的扩展状态操作确认 Selection；确认前不得 materialize pending ranges。确认后，Agent 才能对固定边界执行 locate 和 summary plan。普通聊天中的自然语言不能单独作为隐式状态转换，除非扩展已经定义并验证了对应的输入拦截契约。

### 5. 手动选择模式

手动模式必须在触发模型之前打开独立的 Selection UI。Selection UI 与之后的 Review UI 是两个不同阶段、不同操作集合的界面；不能把 selecting 状态混入 review 状态机。TUI 和本地 Web Selection UI 使用同一份 Selection 状态和相同的边界规则。

Selection 是独立于 DraftPlan 的用户意图状态：它可以在 UI 关闭、reload 或事务中断后恢复，但不能直接 commit。用户确认 Selection 后，扩展才将其展开成 pending ranges，并进入 summarizing 阶段。

用户至少能够：

- 查看全局 inventory 和按用户分组的顺序时间线；
- 选择一个或多个连续 atom 范围；
- 选择整个用户分组；
- 将选中范围中的具体 atom 切换为 KEEP；
- 查看 protected atom、图片 atom 和 tool exchange 的明显标记；
- 查看选择展开后的实际 ranges、原始 content chars、图片数量和预计 replacement content chars；
- 确认选择并进入摘要阶段；
- 关闭并稍后继续选择，或显式 abort。

选择跨过 protected atom 或显式 KEEP atom 时，选择层自动扣除这些节点并拆分为多个连续普通 pending ranges。只有当调用方单独要求压缩某个 protected atom 时才拒绝；最终任何 pending range 都不得包含 protected atom。空片段被丢弃，相邻且没有 KEEP/protected 间隔的片段应合并。

第一版选择边界仍然是 atom。UI 可以更细地展示 tool exchange 内的 Assistant 文本、工具调用和工具结果，但不得允许只压缩其中一部分。

“以一个 atom 为中心保留固定邻域”属于选择便利功能，不是第一版必要条件；用户通过切换相邻 atom 为 KEEP 可以表达同一结果。若后续增加邻域操作，也必须先展开为普通 KEEP atoms 和连续 ranges。

用户确认 Selection 后，扩展持久化 pending ranges，并关闭 Selection UI；之后由独立的 Summary/Review 流程发送一条简短消息给 Agent。消息只包含范围 refs、字符/图片统计和用户 focus，不回显完整 preview。Agent 不得扩大或移动用户选定边界，除非先向用户说明并获得明确同意。

### 6. Draft、plan 与 review

Selection、pending ranges 和 review draft 分别是三个阶段：

- Selection：可编辑、不可提交的选择意图；
- pending ranges：用户确认边界后生成，等待 summary；
- review draft：所有 range 都有非空 summary，才可 review/commit。

Selection 和 transaction phase 必须在 session custom entry 中可恢复。关闭 UI 不清除 Selection；reload 后可以继续编辑。Selection 确认后中断，则恢复 pending ranges 和 summarizing phase，而不是重新解释 Selection。

硬约束由运行时执行，而不是只写在 prompt 中：selecting 阶段拒绝 `plan add`；Agent propose 在用户确认 Selection 前不得生成 pending ranges；User select 只允许为已确认范围补 summary；commit 统一检查 pending、重叠、无效边界和 protected atom。

- 手动选择产生独立 Selection；用户确认后才产生待摘要范围；
- Agent 为每个 pending range 写入独立摘要；
- 一个被 KEEP 洞拆开的选择产生多个范围，每个范围需要自己的摘要；
- commit 在存在空摘要、边界无效、跨 protected atom 或范围重叠时拒绝执行；
- 已有 compression state 只接收完整、可提交的范围。

Agent-facing 的 plan mutation 结果保持简短：显示 revision、范围 ref、字符/图片统计和整体完成状态，不回显 summary，也不重复长边界 preview。完整 summary 只在用户 review UI 中显示，或在显式请求完整草案时返回。

Review UI 只处理已经生成 pending ranges 的 review draft，不提供 group/span/KEEP 选择操作。Selection UI 负责范围选择和确认；Review UI 负责 summary/topic 编辑、range 删除和最终检查。两者可以共享统计数据和 transport shell，但不能共享同一个界面状态机。

Review 必须同时显示：

- KEEP 与各 range 的边界；
- 每个范围的原始 content chars；
- 实际投影 replacement message 的 content chars，包括 midcompact 包装文本；
- 字符减少量；
- 图片数量和 payload 字节数；
- summary 完成状态和正文。

字符减少量只是字符差值，不得称作 token savings，也不得推导提交后的上下文占用比例。

### 7. 图片与召回

图片内容必须在 atom、inventory、selection、draft、commit state 和 recall 中可见，不得静默遗漏。

- 图片存在不会自动使 atom protected；用户和 Agent可以选择压缩图片所在 atom；
- UI 和工具输出必须突出显示选中范围含有图片；
- summary 必须承载后续工作仍需要的图片结论；需要保留像素级或视觉原文时应 KEEP，不能只依赖摘要；
- 普通 `recall(ref)` 至少以占位记录列出原消息中的每张图片，包括顺序、MIME、payload 字节数和可用尺寸；默认 recall 不把图片 base64 自动重新注入上下文；
- 无法解析图片元数据时仍保留图片数量，不得静默表现为该 block 没有图片。

按 block 和图片序号将原图重新注入模型属于后续能力，不是第一版要求。无论是否实现该能力，原始 session entry 中的图片 payload 都不能被 midcompact 改写或删除。

文件名或原始磁盘路径不一定存在于持久化消息中。扩展不得根据 MIME 或上下文猜测文件名。

### 8. Commit、abort 与分支隔离

现有核心保证保持不变：

- commit 只能由用户命令执行；
- commit 返回锚点，丢弃临时规划分支的上下文影响，并写入 branch-local compression state；
- abort 返回锚点且不改变 active compression state；
- 原始 session entries 保留；
- 精确 message sequence 无法解析时 fail open，发送原文；
- 已有 compressed blocks 在后续事务中保持 protected。

## Implementation Decisions

### 数据统计

建立独立的消息内容统计层，不再通过面向人阅读的 rendered text 推导字符和图片数据。`types.ts` 只定义共享数据结构；`content-metrics.ts` 唯一拥有统计规则和实现；`messages.ts` 保留渲染、message key、tool-call 辅助；`atoms.ts` 只负责协议安全分组和 atom 聚合。该层按消息 content part 和 coding-agent 特有字段统计：

- 文本、thinking、tool call 名称与规范化参数表示、工具结果文本、bash command/output、custom/summary 内容分别计数；
- 聚合层产生 message、atom、group、range 和全局统计；
- 图片单独记录顺序、MIME、解码字节数和可选尺寸；
- 统计口径在工具说明和 UI 中保持一致。

统计值描述的是 midcompact 所见消息 payload，不宣称等于 provider 最终请求 JSON 的字符数。

### Atom 与展示层

当前 protocol-safe atom 边界继续作为压缩和选择边界。为了提升可理解性，UI 可以展示 atom 内部的消息组成，但展示单元和压缩单元必须明确区分。

### Selection 与 Draft

Selection 是独立于 DraftPlan 的前置状态，而不是 draft 的别名。它记录用户或 Agent 的选择意图、KEEP 节点、确认状态和可恢复阶段；确认后才展开为 pending ranges。新 DraftPlan 支持无摘要范围；所有范围完成摘要后才形成 review draft。旧 draft 能恢复为已有的完整范围。长期 compression state 仍只存储完整 block，并增加字符和图片事实字段。

现有 approximate-token 字段为了读取旧 session 可以继续兼容，但新流程不得依赖它们做行为决策或对外权威展示。新增字段应允许旧 state 在无迁移写回的情况下继续投影和 recall。

### 自动拆分

选择层统一拥有“范围减去 KEEP/protected atoms”的算法。requested span 可以跨过 protected/KEEP atom，选择层从结果中扣除它们；只有单独要求压缩 protected atom 时拒绝。算法输出排序、无重叠且不含 protected atom 的连续 atom spans，再由 draft 层分配 range ID。Agent 工具、TUI 和 Web UI 不应各自实现不同的拆分规则。

### 生命周期

事务状态需要记录规划模式和阶段，使 reload、tree navigation 和重新打开 UI 后能够恢复：

- selecting；
- selection-confirmed；
- summarizing；
- ready for review。

Selection 单独持久化，关闭 UI 不等于清除 Selection。Agent propose 必须通过显式用户确认命令或等价的扩展状态操作从 selection-confirmed 进入 summarizing；User select 也必须先确认 Selection 才能 materialize pending ranges。运行时拒绝 selecting 阶段的 `plan add`、未经确认的范围 materialization，以及 User select 对已确认边界的修改。只有显式 abort 或 commit 才结束事务。

### Skill

Skill 应缩短为执行协议和语义守恒清单，重点包括：

- inventory first；
- 字符事实与 Pi usage 的来源边界；
- 用户拥有范围和深度决策；
- Agent 模式先提案后 plan；
- 手动模式不得擅自改变边界；
- 用户约束、纠正、决策理由、验证结果、未解决事项和图片语义的保留要求；
- recall 是恢复路径，不是 summary 遗漏信息的默认载体。

## Compatibility And Non-Goals

兼容要求：

- 已提交的 v1 compression state 继续恢复和投影；
- 现有 locate、plan、recall 基本用途继续可用；
- 现有 Agent-first start 用法继续有明确等价入口；
- Selection TUI 与 Selection Web UI 使用相同 Selection 数据和规则。
- Review TUI 与 Review Web UI 使用相同 review draft 数据和规则。
- Selection UI 与 Review UI 的操作集合和状态机保持分离；Web server/shell 可以共享，但 view route 必须明确区分 `view=selection` 与 `view=review`。

第一版不要求：

- 精确 provider tokenizer；
- 按模型计算每组 token；
- 从 payload 字节数估算图片 token；
- 恢复历史运行时 turn ID；
- 压缩单个 tool exchange 内部的一部分；
- 持久化一种带洞 compression block；
- 自动合并已经提交的 compressed blocks；
- 事务外可执行选择；
- 自动 KEEP 邻域快捷操作；
- 按 compressed block 和图片序号将原图重新注入模型。

## Acceptance Criteria

### Inventory

- 对包含中英文、thinking、工具调用参数、工具结果、bash、custom summary 和图片的锚点，inventory 返回确定且可复算的 content chars、图片数量和 decoded payload bytes。
- 同一锚点重复 inventory 得到相同 group refs、atom spans 和统计结果。
- 第一条 User 消息前的内容进入明确的前置分组。
- 默认最多返回 20 组，超过时返回可继续读取的游标；一页不包含正文 preview 或图片 base64。
- Inventory 只显示 Pi 提供的 context window/usage 以及扩展计算的字符/图片事实，不显示本地 estimated tokens。
- Pi usage 不可用时输出 unavailable，不从字符数反推。

### Selection

- `/midcompact start` 在任何选择之前冻结锚点。
- 无显式模式时保持现有 Agent-first；显式 User select 入口进入 selecting 阶段，并在完整 TUI/Web UI 之前也能通过简单命令或选择操作完成 mode choice。
- Agent propose 和 User select 都产生可恢复的 Selection；Selection 未确认前不可 materialize pending ranges。
- 手动模式在 Selection 确认前不触发模型调用。
- 用户选择一个跨越 KEEP 和 protected atoms 的长范围后，系统生成正确、排序且不重叠的多个普通 ranges。
- 用户不能选择半个 tool exchange。
- 关闭并重新打开选择 UI 后，选择和阶段状态仍可恢复。
- Selection TUI 和 Selection Web UI 对同一选择产生相同 ranges。
- Review UI 不提供 Selection 操作；Selection UI 不提供 summary/topic review 操作。

### Summary And Review

- 手动选择完成后，Agent收到的提示只包含必要 refs、字符/图片统计和用户 focus，不包含完整会话转储。
- 每个待摘要范围都必须获得独立非空 summary 才能 commit。
- Agent-facing plan mutation 结果不回显 summary，也不重复长 preview。
- Review 显示原始 content chars、实际 replacement content chars、字符差值和图片事实，不显示本地 token savings 或 projected token percentage。
- Agent 模式在首次 plan 前调用 inventory，并先持久化候选 Selection、再等待用户显式确认；确认前不能 materialize pending ranges。

### Images And Recall

- 图片不会被文本字符统计吞掉，也不会因当前 text renderer 忽略 image part 而从 inventory/recall 中消失。
- 选中图片范围时，TUI/Web review 和 commit 前检查都明显显示图片数量。
- 普通 recall 返回图片占位元数据，且不会默认把图片 base64 重新注入上下文。

### State And Safety

- 旧 compression state 的恢复、投影和文本 recall 测试继续通过。
- Commit 仍只能由用户执行，并拒绝 pending summary、重叠范围、无效边界和 protected atom。
- Abort、commit、tree rollback、重复事务和 fail-open projection 行为保持不变。
- Typecheck、完整自动化测试和 package dry-run 通过。

## Deferred Decisions

以下事项不阻塞总体方案，实作时选择最小且兼容的形式，并在需要改变外部行为时更新本 SPEC：

- 显式 Agent/User 模式参数的最终 CLI 拼写；
- group cursor 的具体编码；
- 图片尺寸解析失败时的 UI 细节；
- 是否在 inventory 总计中提供按内容类型的额外字符 breakdown；
- 事务外只读 inventory 预览；
- KEEP 邻域快捷操作。
