---
title: webui-review-ux 实现交接(待必修、走查与合并)
created: 2026-09-02T03:23:54+08:00
---

## Assume Reader

接手的 Pi Coding Agent,新会话、零对话上下文,工作目录为本仓库、分支 `feat/webui-review-ux`。可稳定恢复的来源:仓库 `AGENTS.md`;`.dev/changes/webui-review-ux/webui-review-ux.SPEC.md`(变更契约,权威,下称 SPEC);`.dev/changes/webui-review-ux/decisions.md`(原型期日志);git 历史(`main...HEAD` 的提交与 diff);`npm test` 等可重复命令。除此之外的会话内容不可用,本文只补这些来源覆盖不了的执行缺口。

## Background Context

任务源于对扩展自带 WebGUI(`review-webui` / `select-webui` 两视图)的 UX 审查:原页面缺少判断支持(看不到 atom 原文、看不到 commit 后投影、pending 要到终端才暴露)、文案系统腔、字小且挤、时间线无层次。方向经多轮原型评审定稿为 SPEC(2026-09-01 修订版)。审查前研读的材料:`src/SPEC.md`、review-webui 旧实现、`skills/midcompact/`、README 双语;实现期间同步修订了 `src/SPEC.md` 的估算契约。

## Current Status

总目标:按 SPEC 在 `feat/webui-review-ux` 完成 WebGUI 改版、通过验证、合回 main。当前:实现与自动化验证已完成;两轮独立只读代码审查均无阻塞合并的问题;SPEC 已按文字审查修订口径。**尚未做**:§2 的两个必修行为缺陷、SPEC §5 第 4–9 项的浏览器人工走查、合并。工作区干净,HEAD = `06ceb3b`。

## Trajectory

审查与定向:对旧版 `src/review-webui.html` 做问题分析,产出按优先级的优化清单;期间确认了几条产品硬约束,后来落入 SPEC §2"明确不做"。

功能原型:第一版单页原型因视图叠加 bug 与信息混杂被否;重构为"总览页 + hash 子路由"(Review / Selection × 现状 / 提案 四页)并改亮色主题,该结构获认可;"protected" 术语误标 user 消息一事被澄清,用户面文案定为 "can't compress",并作为变更项记录。

投影条:用户提出把锚点占用条升级为 now → after-commit 的估算投影。经三次迭代收敛:区间带与三段式形态先后被否,定为两段式(实心 = commit 后点估计,斜纹 = 将被释放);假数据调整到真实量级;原型中的 ±15% 等占位值被明确禁止带入正式实现(见 SPEC D5)。

Selection 语义:澄清 protected 是生产既有概念(四类永不可压缩 atom);user 消息改为可选;三态(Add/Keep/不选)简化为两态(未选 = KEEP)。

视觉原型:同一界面五个变体对比(A 现状暗色对照、B/C shadcn 亮/暗、D 宽松密度、E 视觉锚点)。用户确认 D 的字阶密度与 E 的锚点;另确认绿色削减数字加粗、预览与度量分列的布局纪律。E 为落地基线。

SPEC 定稿:全部决定收口为 SPEC;随后实现(见下)与文档同步。

实现与验证:服务端(原子文端点 + 字符分类估算输入)、页面重写、文档三个提交,加一个 TDZ 修复提交;自动化验证全绿。随后两轮只读代码审查(前端页 / 服务端+测试+文档)均无阻塞问题,发现项按"是否实质影响决策质量"裁剪:2 项必修、其余缓修;SPEC 依文字审查修订三处口径(投影条基线与分母、Projected 过滤语义、验收样例)。

## Key Information for the Successor

已完成:SPEC §3/§4 的实现主体;`GET /api/atom/:ref`;估算器与假设表在 `src/content-metrics.ts`(`TOKEN_ESTIMATE` / `charClassCounts` / `estimateTokens`),页面经 `state.est` 读取;README 双语、`CHANGELOG.md`、`src/SPEC.md` 已同步。

必修(合并前;SPEC §3.1/§3.2 为契约依据):
1. **关闭对话框绕过 pending 警告** — `src/review-webui.html` 中 `$('close')` 的 click 处理器:条件 `dirtyIds().length || selectionDirty` 需加入 `pendingIds().length`(仅 review 视图;selection 下恒空)。对话框内的 pending 文案与 Fix pending 按钮逻辑已存在,无需改。
2. **Selection 光标与查询过滤错位** — 同文件 `renderSelectionTimeline`:`data-idx` 只对渲染出的行递增,被查询隐藏的组造成行号跳号,而键盘 cursor 直接索引 `state.atoms`,Space/G 会操作到不可见 atom。修法:被跳过的组仍推进全局计数(`idx += g.atoms.length`),使 `data-idx` 恒等于 `state.atoms` 下标。

缓修(用户裁定不阻塞合并;每项都是小改,已在审查中定位到函数):markDead 只挡鼠标不挡键盘;Projected 模式未套用 policy/查询过滤(按 SPEC §3.2 修订句实现);Expand all 缺少非选中 range 预折叠种子;pending 判定应改用 `draftOf(r).summary` 且 summary 输入也触发 renderTimeline;saved-badge 未接线;`atomRowRaw` 丢弃 toolNames/roles(恢复 toolTag);≤880px 缺 `.atom.srow` 网格覆盖;atom 端点测试 fixture 应 >700 字符并补 selection 视图调用。

用户指导(仅限本变更范围,勿泛化):
- 浏览器不加 commit 按钮;估算只展示、永不参与门禁——这两条不可作为"顺手改进"突破。
- 视觉以 `prototype-visual.html` 变体 E 为基线;任何视觉改动必须亮/暗双主题同验。
- 用户面文案 "can't compress";agent/工具面术语仍是 "protected"——两套词汇不互相"统一"。

### 雷区(一行一条,防止重启事故)

- `src/review-webui.html` 的 `<!--MIDCOMPACT_STATE-->` 是服务端模板替换点,不可改名/删除。
- `selectionRefs` 初始化必须在 `rangeAtoms` 等 helper 定义之后(曾因顺序产生 TDZ 崩溃,勿回移)。
- 测试基线 63/63;`npm run typecheck`、`npm run typecheck:contract`、`npm run pack:check` 同绿才算验证完整。

## File Reference Map

- `.dev/changes/webui-review-ux/webui-review-ux.SPEC.md` — 变更契约,权威(2026-09-02 修订:投影条基线/分母、Projected 过滤语义、验收样例、状态行)
- `.dev/changes/webui-review-ux/decisions.md` — 原型期决策日志(历史,冲突以 SPEC 为准)
- `.dev/changes/webui-review-ux/prototype.html` / `prototype-visual.html` — 评审原型(证据,不进产品)
- `src/review-webui.html` / `src/review-webui.ts` / `src/content-metrics.ts` — 实现主体
- `test/core.test.mjs` — 含本次新增的 5 个测试
- 合并与发版流程:仓库 `AGENTS.md`(merge `--no-ff`;发版才 bump version + 在 main 打 `v*` 标签)
