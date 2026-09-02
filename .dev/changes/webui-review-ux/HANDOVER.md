---
title: webui-review-ux 实现交接(待必修、走查与合并)
created: 2026-09-02T03:23:54+08:00
---

## Assume Reader

接手的 Pi Coding Agent,新会话、零对话上下文,工作目录为本仓库、分支 `feat/webui-review-ux`。可稳定恢复的来源:仓库 `AGENTS.md`;`.dev/changes/webui-review-ux/webui-review-ux.SPEC.md`(变更契约,权威,下称 SPEC);`.dev/changes/webui-review-ux/decisions.md`(原型期日志);git 历史(`main...HEAD` 的提交与 diff);`npm test` 等可重复命令。除此之外的会话内容不可用,本文只补这些来源覆盖不了的执行缺口。

## Background Context

任务源于对扩展自带 WebGUI(`review-webui` / `select-webui` 两视图)的 UX 审查:原页面缺少判断支持(看不到 atom 原文、看不到 commit 后投影、pending 要到终端才暴露)、文案系统腔、字小且挤、时间线无层次。方向经多轮原型评审定稿为 SPEC(2026-09-01 修订版)。审查前研读的材料:`src/SPEC.md`、review-webui 旧实现、`skills/midcompact/`、README 双语;实现期间同步修订了 `src/SPEC.md` 的估算契约。

## Current Status

总目标:按 SPEC 在 `feat/webui-review-ux` 完成 WebGUI 改版、通过验证、合回 main。当前:实现、自动化验证、两轮独立只读审查(均无阻塞)、第一轮人工走查及其修复均已完成;走查发现的用户可见回退(折叠失效、Projected 过滤、选中凸显弱、投影条无交互)已在提交中修复并用行为级 DOM 桩验证;剩余缓修 5 项(见下)。**尚未做**:第二轮走查复查、合并。工作区干净;提交序列见 `git log --oneline main..HEAD`。

## Trajectory

审查与定向:对旧版 `src/review-webui.html` 做问题分析,产出按优先级的优化清单;期间确认了几条产品硬约束,后来落入 SPEC §2"明确不做"。

功能原型:第一版单页原型因视图叠加 bug 与信息混杂被否;重构为"总览页 + hash 子路由"(Review / Selection × 现状 / 提案 四页)并改亮色主题,该结构获认可;"protected" 术语误标 user 消息一事被澄清,用户面文案定为 "can't compress",并作为变更项记录。

投影条:用户提出把锚点占用条升级为 now → after-commit 的估算投影。经三次迭代收敛:区间带与三段式形态先后被否,定为两段式(实心 = commit 后点估计,斜纹 = 将被释放);假数据调整到真实量级;原型中的 ±15% 等占位值被明确禁止带入正式实现(见 SPEC D5)。

Selection 语义:澄清 protected 是生产既有概念(四类永不可压缩 atom);user 消息改为可选;三态(Add/Keep/不选)简化为两态(未选 = KEEP)。

视觉原型:同一界面五个变体对比(A 现状暗色对照、B/C shadcn 亮/暗、D 宽松密度、E 视觉锚点)。用户确认 D 的字阶密度与 E 的锚点;另确认绿色削减数字加粗、预览与度量分列的布局纪律。E 为落地基线。

SPEC 定稿:全部决定收口为 SPEC;随后实现(见下)与文档同步。

实现与验证:服务端(原子文端点 + 字符分类估算输入)、页面重写、文档三个提交,加一个 TDZ 修复提交;自动化验证全绿。随后两轮只读代码审查(前端页 / 服务端+测试+文档)均无阻塞问题,发现项按“是否实质影响决策质量”裁剪。

SPEC 文字审查与交接:按反 AI 腔 skill 审查 SPEC,修了三处口径缺失(投影条基线/分母、Projected 过滤语义、验收样例)及几处陈旧表述。

走查与修复:用户实测发现 4 个用户可见回退,其中折叠失效是审查漏网的新 bug(gbody 可见性改为 hidden 属性驱动后,点击处理器仍只 toggle class);全部修复,并新增环境变量门控的 debug 预览扩展(见下),行为级验证用可派发点击的 DOM 桩完成(tmp/webui-smoke.mjs,15 项断言)。

## Key Information for the Successor

已完成:SPEC §3/§4 的实现主体;`GET /api/atom/:ref`;估算器与假设表在 `src/content-metrics.ts`;README 双语、`CHANGELOG.md`、`src/SPEC.md` 已同步;两轮审查发现已全部处置(必修已修,缓修见下)。

已修复(审查必修 + 走查第一轮,行为级桩验证通过):关闭对话框对纯 pending 也弹出拒绝警告与 Fix pending;Selection 键盘光标与查询过滤对齐(被隐藏组仍推进全局计数,data-idx 恒等于 atom 下标);组头点击折叠失效(gbody hidden 同步);Projected 模式套用 policy/查询过滤(SPEC §3.2 修订句);选中 atom 凸显增强(2px outline + 左缘色条);投影条点击切换 Raw ⇄ Projected;非选中 range 预折叠种子;pending 标记实时化(draftOf + summary 输入触发重渲染)。

缓修(用户裁定不阻塞合并;每项都是小改,已在审查中定位):markDead 只挡鼠标不挡键盘(键盘事件加 body.dead 守卫 + 禁用控件);saved-badge 未接线(render() 中 selection 无脏时显示);`atomRowRaw` 丢弃 toolNames/roles(恢复 toolTag);≤880px 缺 `.atom.srow` 网格覆盖;atom 端点测试 fixture 应 >700 字符并补 selection 视图调用。

### Debug 预览(避免每次真实触发 midcompact)

- 用法:直接用 `pi-invoke-this.ps1` 进会话,敲 `/midcompact:debug-ui` ——参数带补全(`review` 默认 / `selection`),非法参数会被拒绝并提示有效值;打开 workbench 后所有保存/删除/圈选只改内存,不写 session。
- 隔离契约:文件 `dev/midcompact-debug-ui.ts` 不被 package.json 的 pi.extensions 引用,仅由本仓库的启动脚本以 `-e` 加载;不 import `src/index.ts`;只用 getBranch 只读;改动任何一方前先重读文件头注释。
- 验收标准(改完 debug 相关代码后):正常 npm 安装(pi.extensions 路径,不经启动脚本)时会话内无该命令;走完一遍保存/删除/圈选后,session JSONL 无新增条目。

用户指导(仅限本变更范围,勿泛化):
- 浏览器不加 commit 按钮;估算只展示、永不参与门禁——这两条不可作为“顺手改进”突破。
- 视觉以 `prototype-visual.html` 变体 E 为基线;任何视觉改动必须亮/暗双主题同验。
- 用户面文案 "can't compress";agent/工具面术语仍是 "protected"——两套词汇不互相“统一”。

### 雷区(一行一条,防止重启事故)

- `src/review-webui.html` 的 `<!--MIDCOMPACT_STATE-->` 是服务端模板替换点,不可改名/删除。
- `selectionRefs` 初始化必须在 `rangeAtoms` 等 helper 定义之后(曾因顺序产生 TDZ 崩溃,勿回移)。
- `gbody` 可见性由渲染期 hidden 属性驱动;若改回 class 驱动,必须同步点击处理器(本轮回归根源)。
- 测试基线 63/63;`npm run typecheck`、`npm run typecheck:contract`、`npm run pack:check` 同绿,外加 `node tmp/webui-smoke.mjs`(行为级桩)才算验证完整。

## File Reference Map

- `.dev/changes/webui-review-ux/webui-review-ux.SPEC.md` — 变更契约,权威(2026-09-02 修订:投影条基线/分母、Projected 过滤语义、验收样例、状态行)
- `.dev/changes/webui-review-ux/decisions.md` — 原型期决策日志(历史,冲突以 SPEC 为准)
- `.dev/changes/webui-review-ux/prototype.html` / `prototype-visual.html` — 评审原型(证据,不进产品)
- `src/review-webui.html` / `src/review-webui.ts` / `src/content-metrics.ts` — 实现主体
- `dev/midcompact-debug-ui.ts` + `pi-invoke-this.ps1` — 门控式 debug 预览(见 Key Information)
- `tmp/webui-smoke.mjs` — 行为级 DOM 桩冒烟(gitignored;丢失可按 SPEC §5 重写)
- `test/core.test.mjs` — 含本次新增的 5 个测试
- 合并与发版流程:仓库 `AGENTS.md`(merge `--no-ff`;发版才 bump version + 在 main 打 `v*` 标签)
