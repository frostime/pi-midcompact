# 面向 Agent 的词汇表(Agent-Facing Vocabulary)

本表是 midcompact 契约用词的**权威规范**:一切模型可见与用户可见的文案——工具 schema 字段描述、运行时提示、报错与 TUI 通知、斜杠命令描述、`skills/midcompact/` 文档——必须使用这里的词,不得发明同义词。

不约束:代码内部标识符(类型名、变量名)、持久化 entry 名、测试标题。内部词汇与契约词汇的边界是**单向门**:内部名不得出现在契约面;契约词可以出现在注释。

## 原则

1. **一名一义**:一个概念只允许一个词。同义词不是文采,是缺陷。
2. **动词是动作,名词是实体**:动作名不得降格为参数(反例:`detail` 曾在 plan 里承担操作判别,引发跨字段条件,已由 `plan_show`/`plan_read` 取代)。
3. **schema 与散文是同一门语言**:参数描述、报错、提示、文档用同一套名词;模型不会读两套词表。
4. **id 前缀即地址空间**:可寻址性由前缀声明,不由散文暗示;"X 不是 ref"这类免责句的出现即词汇设计失败。
5. **"模式"不是实体**:凡合法性取决于另一个字段取值的参数组合,应摊平为独立动作,而不是加模式位或跨字段条件。

## 名词(实体)

| 词 | 指称 | id | 禁用同义词 |
|---|---|---|---|
| **anchor** | 冻结快照:事务开启时的历史只读视图,一切规划操作的背景 | — | snapshot(单独使用)、frozen context |
| **atom** | 最小可选单元;一次工具调用与其相邻结果不可分;无结果的冻结调用可构成 abandoned exchange;有 protected/compressible 之分 | `a0001` | message、item、chunk、entry |
| **plan** | 每事务唯一的压缩提案;用户与 Agent 共享编辑 | — | DraftPlan、the draft、draft range |
| **range** | plan 的成员:连续 atom 区间 + 替换摘要(±topic);summary 为空 = pending;边界不可就地修改 | `d1` | draft range、span、selection |
| **block** | range 经人工 commit 后的永久形态;唯一可 recall 的对象 | `c0001` | compressed draft、commit result |

## 动词(动作,11)

| 组 | 动作 | 语义 |
|---|---|---|
| 读锚点 | `inspect` | 分页清单:结构、体量、保护计数 |
| | `measure` | 候选区间测量,**不改 plan** |
| | `locate_ref` | 按 ref 直查一个 atom |
| | `locate_search` | 合取(AND)过滤,至少一个 filter |
| 改 plan | `plan_show` | 零字段:全部 range 的 brief 总览 |
| | `plan_read` | 单 range 全文钻取(`range_id` 必填) |
| | `plan_add` / `plan_update` / `plan_remove` | 增改删;update 只动 summary/topic,边界变更走 remove+add |
| 读既成 | `recall_list` / `recall_read` | 列表 / 渲染,免事务 |

参数命名随动作走。禁止"一个参数表 + `op`/`detail` 模式位"的形态——那是字段合法性不可见、静默忽略的根源。

## 机制词

- `page_size` / `cursor`:通用 cursor 分页,非领域概念,无需同义词管理。
- `detail`:仅存在于 `locate_ref`(输出深度)与 `recall_read`(渲染上限);不得再承担操作判别或携带跨字段前置条件。
- `abandoned exchange`:冻结 anchor 中含工具调用、但对应结果在 anchor 任何位置都不存在的 atom;可整体压缩。禁止 `open protocol`、`incomplete exchange`。
- `ambiguous tool protocol`:调用/结果关系非相邻、重复或无法唯一归属;对应 atom 为 protected。
- `orphan result`:没有被相邻调用 atom 接纳的工具结果;为 protected。

## id 空间与标签

| 形态 | 性质 | 文案必须称 |
|---|---|---|
| `a0001` | 可寻址:atom ref(事务本地,跨事务失效) | ref |
| `d1` | 可寻址:range id(随 plan 持久化) | range id |
| `c0001` | 可寻址:block id(随 state 持久化) | block id |
| `g0001` | **不可寻址**:inspect 清单行的显示标签 | label(禁称 ref) |

## 禁用与替换(历史教训沉淀)

| 禁用 | 替换为 | 教训 |
|---|---|---|
| `DraftPlan` / the draft / draft range(名词) | plan / plan range | 三名一物;"未提交"这一状态已由事务生命周期与人工 commit 门表达,不配独占名词 |
| `span` 作参数名/实体名 | `measure` / `candidates` | 函数参数被抬升为实体;散文中 span 仅可作普通名词指 {start,end} 对 |
| plan 的 `detail` 参数 | `plan_show` / `plan_read` | 修饰符伪装成判别式,拖着 `full⇒draft_id` 类跨字段条件 |
| 把 `g…` 当 ref | `g…` label + `a…` 区间定位 | 制造免责声明("not a locate ref")的概念不该存在 |
| 模式位 `op` / 值模式分支 | 顶层动作摊平 | 二级判别式使字段合法性对 schema 不可见 → 硬拒绝与静默忽略并存 |
| 共用字段名跨动作复用(`ref`/`pattern`/`limit`/`detail`) | 分支特化字段(`locate_ref.ref` / `recall_read.block`) | 一名多义迫使模型按分支重新解释同一字段 |

## 新增词汇的流程

新增 action、字段或概念时,**先在本表登记,再写代码**:

1. 检查与现有词无同义冲突(搜本表与 `rg -i "draft|span|detail"` 类旧词面);
2. 实体入名词表、动作入动词表;若是"模式",摊平为动作;
3. id 新前缀须显式声明可寻址性;
4. 同步 `skills/midcompact/SKILL.md`、`skills/midcompact/references/tool-interface.md` 与本表,三者一起过 grep 门。

词定了,代码只是词的执行。
