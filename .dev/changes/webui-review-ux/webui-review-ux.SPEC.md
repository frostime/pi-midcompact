# WebGUI UX 改版 — Code Change Spec

变更代号:`webui-review-ux` · 日期:2026-09-01 · 状态:**spec 定稿,待实现**
迭代过程见同目录 `decisions.md`(原型期日志)与两份原型(`prototype.html` 功能 / `prototype-visual.html` 视觉)。本文是收口后的权威依据,与日志冲突时以本文为准。

---

## 1. 问题陈述

WebGUI(`review-webui` / `select-webui`)是 Pi 无 TUI 模式下的人工门禁工作台:Review 视图判断"Agent 起草的压缩方案能否 commit",Selection 视图由用户自选压缩范围。现状的问题(经原型逐项确认):

1. **判断依据缺失**:浏览器端只有 700 字符截断 preview,无法核对摘要忠实性;看不到 commit 后的上下文形状;没有聚合决策数字;空 summary( pending)的 range 要到终端 commit 才撞上拒绝;服务端关闭后页面变僵尸仍可编辑。
2. **交互效率**:Selection 核心圈选纯鼠标;Add/Keep/不选三态中 KEEP 与"不选"投影等价,是伪差异;编辑器操作行会滚出视口;刷新丢失现场。
3. **文案与术语**:系统腔外泄("DraftPlan"、"provider usage fact · no local token estimate"、"payload facts only"、"not compressible");内部术语 "protected" 直接面对用户。
4. **视觉**:基准 13px、辅助文本 10–10.5px、留白不足导致拥挤;时间线是无层次灰墙,扫读易疲劳;多彩 accent 挤占了语义色的表达。

成功标准:用户能在浏览器内完成"判断并修订草案"的全过程(核对原文 → 看投影 → 补 pending → 保存 → 得到下一步指引),之后顺畅交还终端 commit;界面符合第 4 节确认的视觉与文案规范。

## 2. 方案概述

沿用现有单文件页面 + loopback HTTP 的架构(不引入框架/构建链),做一次原地改版:

- **功能层**:决策条替代四张指标卡;Timeline 增加 Raw ⇄ Projected 切换;新增只读 API 提供原子文;pending 三处前置;reviewed 清单;吸底操作行;死会话横幅;Selection 简化为两态 + 键盘圈选;文案全面去系统腔。
- **视觉层**:shadcn 式克制(zinc 中性面 + 语义色专用)+ 宽松密度(基准 14px)+ 时间线视觉锚点。双主题(亮/暗)都要。
- **明确不做**:浏览器内 commit 按钮;估算参与任何门禁/决策逻辑;remove 撤销(需新增服务端写契约,收益不匹配)。

被否决的替代:三段式投影条(实心/落点带/斜纹)——落点带不可自释,已由两段式 + 数字区间取代;Token 级本地精确计数——目标模型因 provider 而异,单一 tokenizer 对其他家必然失真。

## 3. 行为契约

以下均为外部可观察行为;[术语](#7-术语)见文末。

### 3.1 双视图共用

- **决策条**:一行显示 `draft 范围数 · coverage(atoms) · anchor content 削减(−chars,−%,事实值) · pending 数`,右端为投影条(见下)。数值随草稿编辑与保存实时更新。
- **投影条**:两段式——实心段 = commit 后占用(点估计),斜纹段 = 将被释放;悬停展示换算假设;不确定度只出现在数字(`est. ±N%`,N 由内容构成计算,见 4.3)与悬停说明,不画进条形。
- **绿色削减标注**(列表卡、组头、决策条、投影条 delta)一律绿色加粗。
- **死会话检测**:liveness SSE 断开后,页面顶部横幅告知会话已在终端关闭,写操作禁用(只读),提示可关闭标签页。
- **文案规范**:不出现 "DraftPlan"(用 draft/plan)、"provider usage fact"、"payload facts only" 类系统腔;下一步指引明确指向终端 `/midcompact:commit`。
- **布局纪律**:预览区与度量区永远分列,度量列预留固定宽度,预览列 `min-width: 0`,任何缩放下互不重叠。

### 3.2 Review 视图

- **Raw ⇄ Projected 切换**:Raw 显示原始 atom 分组(现状能力保留);Projected 将每个 range 折叠为一张 summary 卡(显示 topic、摘要全文、`N atoms → M chars`、replaced refs),KEEP 组原样保留并标注 verbatim;有 pending summary 的 range 显示虚线警告卡("commit 将拒绝")+ "Write summary" 跳转按钮。
- **原文抽屉**:点击 atom 预览或投影卡 "View original" 侧向抽屉展示该 atom 完整原文,标注 kind 与尺寸;数据来自新增只读 API(见 4.1)。
- **Pending 前置**:range 列表卡显示 pending 标记;投影警告卡;关闭对话框列出 pending ranges 并警告 "commit 将拒绝",提供 "Fix pending" 跳转到对应编辑器。
- **Review 清单**:每个 range 可勾选 reviewed,列表卡同步显示 ✓;状态在页面会话内保持(持久化位置未定,见 §6)。
- **吸底操作行**:Save / Revert / Remove 常驻可见(sticky)。
- **下一步指引**:所有 range 已保存且无 pending 时,编辑器顶部显示绿色指引:草案已保存、尚未应用,回终端执行 `/midcompact:commit`(或 abort)。
- **既有能力回归**:j/k 导航、⌘/Ctrl+S、`/` 过滤、展开/折叠、主题切换、脏状态守卫与关闭确认等现状行为不回退。

### 3.3 Selection 视图

- **两态模型**:选中 = 压缩,未选 = 原样保留(即 KEEP 的表达方式);不再提供 per-atom 的 Add/Keep 按钮对。user 消息为普通可选 atom。
- **不可选 atom**:已压缩块、断开的工具协议、缺锚点条目的消息显示 🔒 与文案 "can't compress"(替代生产现词 "not compressible"),禁用选择;组头 "N/M selected" 分母只计可选 atom。
- **键盘圈选**:`↑/↓` 移动光标、`Space` 选中/取消、`G` 整组切换;鼠标点击行等效 Space;页面获得焦点时生效。
- **实时反馈**:左栏实时列出连续选中段将生成的 ranges(可整段移除);右栏实时汇总 atoms/chars/images 与 "if committed now" 投影条(未计 Agent 之后起草的摘要,悬停说明);顶部一条细汇总替代四张指标卡。
- **保存**:Save selection 后显示已存 chip 与"回终端告诉 Agent 继续"指引;现状的 spans 归一化行为不变。

### 3.4 兼容性

- 工具契约、命令名、持久化条目类型(三类 custom entry)、规划锁语义、人门禁(commit 仅在终端)均不变。
- 服务端仅**新增**只读端点;现有端点行为不变。
- 新页面与 TUI 面、Agent 面继续通过同一 DraftPlan 与锁协作;估算数字对三者均无约束力。

## 4. 实现决策

### 4.1 服务端

- 新增 `GET /api/atom/:ref`:返回该 atom 的完整文本与元数据(kind、chars);ref 不存在返回 404。快照数据已在内存,不新增持久化。
- 4.3 的换算常量与误差带计算收进内容度量模块并写入假设文档;不散落在页面脚本里。

### 4.2 页面(单文件改版,双视图同源)

- 头部四卡 → 决策条;Timeline 双模式容器;编辑器操作行 sticky;抽屉与关闭对话框按 3.2/3.3 行为实现;SSE `onerror` 驱动死会话横幅。
- Selection 光标/选中态为客户端状态;保存走既有 `/api/selection`。
- reviewed 勾选、光标位置等瞬态在页面刷新内的持久化方式未定(见 §6),实现时不得为此新增持久化条目类型。

### 4.3 估算(展示级,无否决权)

- 点估计:字符分类计数 × 分类比例(比例表写入假设文档;原型占位值 0.75 tok/CJK、0.25 tok/ASCII、1.1k tok/图**不得带入正式稿**)。
- 误差带:由各分类比例的区间按内容构成**计算**得出(ASCII 为主 ≈±10–15%,CJK 为主 ≈±25–35%),不是对称常数。
- 展示:数字带 `est.` 标注与假设悬停;条形只画点估计。
- 二阶段可选(默认不做):用 Pi 上报的 commit 前后 usage 差值累积校准系数。
- 契约修订随之落地:`src/SPEC.md` 的"无估算"约束改为"允许展示级估算、无否决权";README(EN + zh-CN)同步。

### 4.4 视觉规范(以 prototype-visual.html 变体 E 为基线)

- Tokens:zinc 中性面(bg/panel/card/elev/ border 三级)、语义色专用(绿=节省、琥珀=pending、红=danger),品牌无彩色主按钮(primary 亮色=近黑、暗色=反白)。
- 字阶:基准 14px/1.6;辅助文本下限 12px;摘要正文 12.5px/1.6;数据与代码一律 mono(tabular-nums);内距整体较现状 +30~40%;右栏 ≈430px、左栏 ≈288px;圆角 8–10px;1px 弱边框、无投影堆叠。
- 时间线锚点:组左侧 3px 色轨(黑=range / 绿=KEEP);user 行实色 chip + 加重正文;kind 低饱和着色(read 青蓝 / bash 琥珀 / assistant 紫);右栏 chars 下带轨道计量条(宽度按视图内最大值归一);正文与元数据两层对比度。
- 微标签对比度 ≥ WCAG AA;保留 `prefers-reduced-motion` 豁免;亮/暗两套 tokens 同时交付。

### 4.5 文案与文档同步

- "protected/not compressible" → **"can't compress"**:`review-webui.html` 标签与帮助文案、`skills/midcompact/` 相关表述同步修改。
- 术语表(§7)作为页面文案与文档的用词基准。

## 5. 验收标准

技术检查(可在仓库执行):

1. `npm run typecheck`、`npm test`、`npm run typecheck:contract` 全绿;新增/调整行为的测试落在既有 58 个 suite 的对应文件中(新 API 的 200/404、selection 两态提交后的 spans 归一化、投影条数值计算)。
2. 契约检查:持久化条目仍恰好三类;commit 拒绝条件不变(pending/reversed/overlap/protected);页面 JS 不含估算参与门禁的逻辑路径。
3. 文档一致性:全仓 rg 无 "DraftPlan"、"not compressible"(用户面文案)、"provider usage fact" 残留;`src/SPEC.md`、`skills/midcompact/`、README 双语与实现一致。

用户验收(浏览器走查 `review-webui` / `select-webui`):

4. 决策条与投影条数值随编辑/保存实时正确;pseudo 数据场景(80% → ≈33%,带 ±N% 区间)与手算一致。
5. Projected 模式:range 折叠为 summary 卡、pending 警告卡可跳转、KEEP 保持;抽屉能看到 atom 全文。
6. 空 summary 时关闭对话框出现拒绝警告与 Fix pending;补全保存后出现 commit 指引。
7. Selection:键盘可完成全流程;🔒 atom 不可选;左栏 runs 与右栏汇总实时正确。
8. 终止会话(终端侧关闭)后页面出现只读横幅。
9. 亮/暗两主题下走查 4–8 无对比度或布局破损。

## 6. 未决问题(不阻塞开工,实现中遇到再定)

1. reviewed 勾选的持久化位置:sessionStorage(页面内)vs 随 draft 持久(涉及持久化契约,倾向前者)。
2. Selection 两态化后,`keepRefs` 参数是否保留兼容(倾向:保留入参、UI 不再产生)。
3. URL 状态恢复(如 `#range=d1`)是否纳入本期(原型未含,属低成本增强)。

## 7. 术语

| 术语 | 含义 |
| --- | --- |
| anchor(锚点) | `/midcompact:start` 冻结的会话叶子快照;压缩的对象,commit 后模型看到的是它的投影 |
| atom | 快照中最小可选单元;一次工具调用及其结果合并为一个 `tool_exchange` |
| range(d1、d2…) | 一段将被摘要替换的连续 atom 区间,携带 topic/summary |
| KEEP | 不进入任何 range、commit 后原样保留的部分;Selection 中由"未选中"自然表达 |
| pending | summary 为空的 range;commit 会拒绝 |
| protected(→ "can't compress") | 永不可压缩的 atom:已压缩块、断开的工具协议、缺锚点条目的消息;界面用 "can't compress" |
| 投影 / Projected | commit 后模型实际看到的上下文形状(range → summary 卡,KEEP 与后续内容不变) |
| 投影条 | 双视图共用的水平条组件:实心=commit 后占用(点估计),斜纹=将被释放 |
| 决策条 | 头部一行聚合:ranges / coverage / −chars% / pending + 投影条,替代四张指标卡 |
| reviewed | 用户对某 range "已核对"的勾选标记,客户端态 |
| liveness | 页面与本地服务端的 SSE 心跳;断开即会话已在终端关闭 |
