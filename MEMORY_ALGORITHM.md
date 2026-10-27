# Snail Memory：记忆算法、设计技巧与演进

本文说明 Snail Memory 当前实现的记忆算法、关键方案取舍和演进过程。描述以 dsh `0.2.1-rc.3` 树外插件及 2026-10-27 的大详情分片实现为基线。

文中严格区分三类机制：

- **确定性算法**：计数、分片、ID 派生、revision、保留期、队列、提交对账等可重复验证的逻辑。
- **模型语义算法**：从对话提炼候选、语义去重、冲突裁决和旧结论取代，由辅助 LLM 完成。
- **宿主事实**：Session、turn、workspace 和模型历史归 dsh 所有，插件只通过公开扩展点读写获准的数据。

## 1. 设计目标与非目标

Snail Memory 解决的是单用户跨会话长期记忆，而不是再实现一套对话压缩器。它把少量稳定知识保存到全局或 workspace 层，在会话明确启用后注入摘要索引，并允许模型按需读取详情。

核心目标：

1. 全局与 workspace 分层，避免项目事实互相污染。
2. 自动蒸馏与显式记住、纠正、忘记并存。
3. 摘要优先、详情按需，大详情再按片读取，控制单次模型可见量。
4. 所有模型可见内容都有普通 Session 消息或工具结果作为证据。
5. 删除只影响记忆，不删除、替换或压缩对话历史。
6. 重启可恢复，多 Host 不静默并发写，秘密不进入长期记忆和审计正文。

当前明确不采用向量数据库、embedding 召回或查询相关性排序，也不自动把所有 workspace 记忆晋升到全局。它不是完整知识图谱或实时事实系统；旧记忆只是带来源时间的参考数据。

## 2. 总体算法视图

```text
真实用户 Session
      │
      ├─ 有效轮计数 ── 每 10 个完成轮 ──→ Review
      ├─ 活动停止 15 分钟 ──────────────→ Idle 蒸馏
      └─ archive / stop ────────────────→ Stop 蒸馏
                                             │
                                  来源准入、扫描与脱敏
                                             │
                                    辅助模型生成候选
                                             │
                                  结构校验、输出安全回扫
                                             │
                              scope 内确定性去重与 upsert
                                             │
                                      dirty + 整合计划
                                             │
                         至多 6 小时后：scope 内语义整合
                         每 24 小时：保留期与显式过期清理
                                             │
                              权威 JSON + Markdown 投影
                                             │
                enable / refresh → 摘要索引快照 → append-only 注入
                                             │
                    snail_memory_read → 小详情 / 分片清单 / 单片
```

这条链路中，模型负责“理解什么值得记、哪些语义相同”，程序负责“能写到哪里、何时写、是否已提交、如何恢复以及不能泄露什么”。

## 3. 数据模型与分层

### 3.1 两种 scope

- `global`：保存用户明确写入的全局记忆，同时维护各 workspace 的引用、条目数、revision 和更新时间，不复制 workspace 正文。
- `workspace`：保存当前 WorkspaceId 下的项目记忆。自动蒸馏只写这一层；Ungrouped 会话没有隐式 workspace，因此不会自动蒸馏到全局。

WorkspaceId 是逻辑身份，canonical realpath 只用于归属校验，不作为记忆 ID。这样避免路径大小写、符号链接或目录解析变化直接重写记忆身份。

### 3.2 五类记忆

| 类别 | 用途 | 默认自动保留期 |
|---|---|---:|
| `preference` | 用户偏好 | 不自动过期 |
| `project-convention` | 项目约定 | 180 天 |
| `environment-fact` | 环境事实 | 30 天 |
| `troubleshooting` | 已验证排障经验 | 180 天 |
| `long-term-decision` | 重要长期决策 | 不自动过期 |

任何类别都可由有效 `expiresAt` 提前过期。保留期从 `lastVerifiedAt` 计算，而不是从创建时间计算，体现“最近重新验证过的事实可以延续”。

### 3.3 父记忆是唯一实体

每条 `MemoryEntry` 包含稳定 ID、scope、类别、摘要、完整详情、创建/更新/最近验证时间、条目 revision、来源引用，以及可选的过期和取代元数据。

主索引只移除 `detail`，不会把分片变成独立记忆。全局索引、workspace 索引、模型快照和 Web 管理页都围绕同一个父条目工作。

## 4. 生命周期触发算法

### 4.1 有效用户轮

只有满足以下条件才计入 Review：

1. 事件是 `user/message`。
2. `source.kind === 'user'`，排除 Snail Memory 注入、调度和 runtime context。
3. 所在 turn 最终以 `completed` 结束；aborted/error 不触发。
4. 同一 turn 的重复或乱序事件不重复计数。

计数器先关联用户消息与 turn，再处理“消息先于完成”和“完成先于消息”两种乱序。每完成 10 个有效用户轮安排一次 Review。

这个设计防止插件自己的记忆注入触发新一轮蒸馏，形成“注入 → 再总结 → 再注入”的自我强化循环。

### 4.2 三类蒸馏入口

| 入口 | 默认时机 | 转录输入预算 | 目的 |
|---|---|---:|---|
| Review | 每 10 个有效完成轮 | 24,000 字符 | 会话进行中的轻量提炼 |
| Idle | 最近活动后空闲 15 分钟 | 48,000 字符 | 对话暂停后的较完整提炼 |
| Stop | archive、session/agent stop | 48,000 字符 | 结束边界提炼 |

活动事件会刷新 idle intent 的创建时间，形成 debounce。三类入口最终复用同一个 `distillSession`，区别主要是输入预算和调度原因。

当前实现取转录的**开头**相应字符数，而不是完整历史或最新窗口。这是预算保护，不应被理解为全量记忆覆盖。

### 4.3 单 timer 与持久 intent

调度器只保留一个必要 timer，所有任务串行执行。`meta.pending` 持久化 Review、Idle、Stop、Consolidate 和 Retention 意图；重启后根据时间恢复到期任务。

- 有实际写入时设置 `dirty`，通常将整合安排在 6 小时后。
- 整合只在 dirty 且到期时运行。
- 保留期清理默认每 24 小时运行。
- Review/Stop 失败后降级为 Idle 意图，空闲类任务按 15 分钟重试。
- 整合和保留期失败分别按各自周期重试。
- 卸载停止新 timer，但等待已经进入队列的工作 drain。
- 错误状态只保存稳定类别，不保存可能包含路径、提示词或秘密的异常正文。

## 5. 蒸馏与确定性去重

### 5.1 蒸馏管线

```text
限定 Session 来源
  → 截取预算内转录
  → 扫描并脱敏；拒绝不可接受内容
  → 要求辅助模型只返回 JSON candidates
  → 校验类别、summary、detail 和 16,000 字符详情上限
  → 回扫模型输出，剔除不安全候选
  → 在当前 workspace 内匹配旧记忆
  → upsert、记录 sourceRefs 和 lastVerifiedAt
  → 有写入则标记 dirty
```

模型输出上限为 64,000 字符，对应调用预算 16,000 max tokens。没有可用模型路由时明确失败并保留可重试状态，不生成虚假记忆，也不伪造整合成功。

### 5.2 稳定 ID

自动蒸馏的新候选使用：

```text
scopeKey = global | workspaceId
normalizedSummary = summary.trim().toLowerCase()
memoryId = SHA256(scopeKey + NUL + category + NUL + normalizedSummary)
```

写入前还会在当前 scope 内查找“同类别且规范化 summary 相同”的旧条目。完全相同的 summary 和 detail 不重复写入；内容改变时沿用旧 ID 并更新 revision。

这个 ID 不是语义相似度哈希。措辞不同的同义记忆仍需要后续 LLM 整合；scope 和 category 参与哈希则防止跨层、跨类别误合并。

## 6. 整合与冲突裁决

整合按 global 和各 workspace 分别执行，不跨 scope 自动晋升。每个 scope 的处理过程为：

1. 按 `updatedAt` 从新到旧排列完整条目。
2. 逐条装入最多 64,000 字符的模型输入；达到预算后停止加入更老条目。
3. 要求模型在当前 scope 内合并重复、修正冲突、淘汰旧结论，返回 candidates 和可选 `supersedes`。
4. 确定性代码只接受当前 scope 已存在的候选 ID；未知 ID 不用于跨 scope 移动。
5. 合并并按 JSON 精确值去重 `sourceRefs`，写回新 revision，再删除同 scope 中被取代的旧 ID。
6. 全部成功后清理 dirty、pending 和下次整合时间。

因此，“语义上是否重复、哪个结论更新”是模型判断；“是否允许写、能否跨 scope、如何持久化和删除”是程序判断。这个分工让语义能力可演进，同时把数据安全边界留在确定性代码中。

整合同样是预算内批处理，不保证每轮让所有历史条目都参与。首条本身过大时只会截取其 detail 以形成降级输入。

## 7. 遗忘算法

遗忘分为自动保留期清理和显式忘记。

自动过期判断：

```text
若 expiresAt 有效且 expiresAt <= now：过期
否则若类别无默认保留期：不过期
否则若 lastVerifiedAt 无效：过期
否则若 lastVerifiedAt + retentionDays <= now：过期
```

显式忘记按 `scope + id` 精确删除，不跨 scope 搜索，不调用模型。删除会推进 scope revision、移除权威条目和详情投影，并安排后续整合。

无论哪种遗忘，都不修改 dsh Session。已经注入的旧快照仍是历史事实，只是不会再出现在未来快照中，且对应详情不再可读。

## 8. 召回、快照与注入

### 8.1 召回不是向量搜索

当前召回策略是“scope 内摘要索引 + 按 ID 精确读取”：

1. Store 按 `updatedAt` 新到旧排列，ID 作为稳定次序兜底。
2. enable 或 refresh 时渲染该层摘要索引。
3. 全局快照额外携带 workspace 引用，不携带 workspace 正文。
4. 模型确有需要时调用 `snail_memory_read`，提供已启用 layer 和父 memory ID。
5. 小详情直接返回；大详情先返回分片清单，再按 chunk ID 读取单片。

每条快照记忆带类别、ID、摘要和“若干天前”的时点提示，并明确它是不可信参考数据，不能覆盖当前用户、系统或安全指令。

### 8.2 快照预算

Token 使用启发式估算：

```text
estimatedTokens(text) = ceil(text.length / 4) + 8
```

默认摘要条目预算为 1,200 估算 token。超限后停止加入后续条目，并提示还有条目可按 ID 读取。该估算不是 provider 的精确计费值；固定头、workspace 引用和尾部说明也不属于当前条目循环的硬上限。

### 8.3 两层单向 enable

新会话的 global 和 workspace 两层均为 disabled，只允许 disabled → enable，两层互不影响。每层只自动创建一次快照；Ungrouped 会话不能启用 workspace 详情读取。

“只加载一次”指自动注入次数，不禁止用户显式 refresh。当前 refresh 仅在 scope revision 高于该层已有 desired 最大 revision 时创建新快照，否则恢复尚未提交的注入并返回 up-to-date。

### 8.4 desired → queued → committed

`agent.inject()` 返回不代表消息已经持久化，因此插件把注入拆成三个事实：

```text
desired：快照、injectionId、revision 已原子持久化
   ↓ restore / agent.inject
queued：本进程已排队，用 Set 防止重复排队
   ↓ 观察到匹配的 post-commit user/message
committed：记录 injectionId、revision、提交时间和估算 token
```

- 重启后重新计算 `desired - committed`，恢复所有未完成注入。
- 重复事件不重复累计 committed 或 token。
- 被宿主 discard 的消息只释放 queued 标记，允许以后重试。
- 已提交快照永不 replace，删除记忆也不追溯撤回。
- token 统计只计算 committed，不把“按钮已点击”当成“模型已经看见”。

快照始终作为 `source: snail-memory` 的用户消息追加到历史尾部，不改 system prompt 头部。这样既保留已有 KV Cache 前缀，也让模型可见内容可由 Session 重建。

## 9. 大详情分片算法

### 9.1 为什么需要分片

只把大详情排除在主索引之外还不够：模型一旦按 ID 读取一个很大的详情，仍会在单次工具结果中突然扩大上下文。分片控制的是**单次模型可见量**，不是修改宿主长 Session 的持久化切片。

### 9.2 确定性无损切分

当前规则：

- `detail.length <= 8,000`：不分片。
- `detail.length > 8,000`：逐片切分，每片最多 4,000 UTF-16 code unit。
- 在前半窗口之外优先选择最近的段落边界，其次换行，再次空格或 Tab。
- 找不到合适语义边界时在 4,000 硬上限处切分。
- 分片 ID 按顺序生成：`part-001`、`part-002`……
- 必须满足 `chunks.map(chunk => chunk.text).join('') === detail`。

这里的长度是 JavaScript UTF-16 code unit，不等于 token，也不等于用户感知字符数。算法不为了“语义美观”丢字符、改换行或规范化正文。

### 9.3 父索引与读取契约

```text
小详情：details/<id>.md
大详情：details/<id>/INDEX.md
        details/<id>/part-001.md
        details/<id>/part-002.md
        ...
```

主 `INDEX.md` 和 `MEMORY.md` 仍只列父摘要，每个父条目只占一项。大详情的工具读取行为为：

- 不传 `chunk_id`：返回父摘要、最近验证时间和有序分片清单，不返回正文。
- 传有效 `chunk_id`：只返回目标单片和父元数据。
- 传未知或空 `chunk_id`：返回未找到，不能回退为完整父详情。
- 小详情传任意 `chunk_id`：同样返回未找到。

Web 管理页仍读取父完整详情供人查看；分片限制只针对模型工具。

## 10. 安全与信任边界

### 10.1 三次把关

1. **输入前**：自动来源必须是获准 Session；发送给辅助模型前扫描和脱敏。
2. **输出后**：模型候选进行结构校验和秘密回扫，不安全候选被剔除。
3. **展示与注入时**：记忆被标记为不可信、带时效的参考数据，不获得指令权限。

显式记住和纠正也不能绕过扫描。普通高置信凭据可替换为 `[REDACTED:<kind>]`；完整私钥块等不可接受内容直接拒绝。扫描预算默认 1,000,000 字符，超预算不会静默截断后假装完成扫描。

### 10.2 日志与审计最小化

审计只记录时间、操作和 revision 等元数据，不写 summary、detail、snapshot、sourceRefs 正文或异常原文。错误对外使用稳定类别，避免把内部路径、提示词和秘密带入 UI 或日志。

安全策略目前由 Controller、Lifecycle 和模型解析路径执行，而不是 `MemoryStore.upsert` 自身的强制不变量。新增生产写入入口时必须复用同一安全策略，不能假设 Store 会自动脱敏。

## 11. 持久化与并发设计

默认数据根为 `$DSH_HOME/snail_memory`。`state.v1.json` 是唯一权威状态，Markdown 是可重建投影，不与 JSON 形成双事实源。

关键技巧：

- 所有 CRUD、Session 状态和调度元数据进入同一串行写队列。
- 权威 JSON 原子替换；写失败不向调用方伪造成功。
- 同一 root 使用独占锁、heartbeat、stale 判定和 writer fencing；第二 Host 明确只读。
- Windows 原子 rename 的短暂 EPERM 使用有限退避，不无上限重试。
- 大详情先在同级临时目录写完整套分片，再切换目标目录；失败恢复旧目录，后续启动清理临时/备份残留。
- 纠正导致缩片、大小形态切换或删除时清理旧投影。
- 删除收尾也位于同一事务队列内，避免“旧删除任务”误删随后同 ID 重建的新分片。

这里最重要的不变量不是“每个文件都写过”，而是“任何时刻都不能把半套新分片和半套旧分片当成一个可用版本”。

## 12. 关键设计技巧与方案取舍

### 12.1 把语义判断与系统不变量分开

LLM 适合提炼、同义合并和冲突解释，不适合承担权限、事务、权限 scope、提交确认和删除顺序。插件让模型产出候选，再由确定性代码决定是否接受。

### 12.2 用单一权威状态派生多种视图

权威 JSON 同时服务 Host、Web 和恢复；Markdown、主索引和分片目录都是投影。这样纠正或遗忘只需改变一个事实源，避免 JSON 与文档各自演化后互相矛盾。

### 12.3 用 revision 驱动显式刷新

scope revision 只在实际 upsert/remove 时前进。刷新基于 revision，而不是比较整段 Markdown，因此重复点击和进程恢复可以使用稳定规则判断是否需要新快照。

### 12.4 用 append-only 换取可审计性

替换旧 system prompt 或旧记忆消息虽然可能减少历史 token，却会破坏前缀稳定性、事实可重建性和删除边界。Snail Memory 选择追加快照，让每次模型可见变化都有历史证据。

### 12.5 把“已排队”和“已提交”分开

如果只用按钮状态或 inject 返回值判断成功，重启、discard 和重复事件都会造成丢失或重复注入。持久 desired 加 post-commit 对账，才能把 UI 反馈、队列状态和模型可见事实区分开。

### 12.6 先限制读取，再限制写入

上下文成本不仅来自常驻摘要，也来自工具一次性返回的大对象。先采用“摘要索引 + 按 ID 详情”，再演进为“分片清单 + 单片”，是在不改变记忆实体和 Session 格式的情况下逐层收紧读取预算。

### 12.7 用失败注入验证真正的不变量

正常 CRUD 测试无法发现目录写一半、旧删除误删新文件等竞争。针对这些风险，测试注入指定分片写失败和受控删除延迟，分别证明旧整套投影保留、删除与重建不会串序。

## 13. 演进过程

### 阶段一：从记忆设想到可验收契约

最初先比较多种 Agent 的记忆方式，再把需求收敛为全局/workspace 两层、五类记忆、自动生命周期、显式操作、摘要常驻和详情按需。

随后先建立 capability map，再分别编写 store、safety、lifecycle、context、API 和 Web Spec。这个阶段确定了几个后续不再让步的边界：树外插件、不动 dsh Session、不动 system prompt、全局不复制 workspace 正文、删除不删除对话。

### 阶段二：按垂直切片形成完整插件

实现顺序为：

```text
store + safety
  → context + lifecycle
  → API
  → Web
  → 隔离安装与整体验证
```

初版已经具备权威 JSON、Markdown 投影、单写者锁、秘密扫描、有效轮计数、蒸馏、整合、保留期、两层 enable/refresh、详情工具、同源 RPC 和双 tab 管理页，而不是先做一个只有 UI 的演示。

### 阶段三：从“调用成功”演进为“提交可证明”

接入真实 dsh 后，最重要的修正是把 inject 返回值从“成功”降级为“queued”，再用 Session post-commit 事件确认 committed。由此形成持久 desired、重启对账、重复事件幂等和 committed token 统计。

真实模型验证进一步确认了自动蒸馏能写入 workspace、整合能清空 pending/dirty、两层快照能在下一次提问中生效，以及全局层只带 workspace 引用。验证使用独立 DSH_HOME 和隔离配置，没有把测试加速参数变成产品默认值。

### 阶段四：从详情按需演进到大详情分片

初版“主索引只放摘要”已经降低常驻上下文，但完整详情仍可能通过一次工具调用全部进入模型。大详情分片因此增加第二层预算控制：

```text
父摘要索引 → 分片清单 → 指定单片
```

实现保留父 JSON 完整 detail，不迁移旧数据、不改变分片前的注入 revision，也不修改 Session。分片只改变派生投影和模型读取方式，因此小详情和 Web 人类详情保持兼容。

### 阶段五：从功能通过演进为失败与竞争可恢复

独立复核发现四个仅靠 happy path 无法覆盖的问题，并分别形成回归测试和修复：

1. **目录内逐片覆盖**：写中途失败会留下半新半旧内容。改为临时目录完整写入、目录切换和失败恢复。
2. **删除清理脱离写队列**：旧删除可能清掉同 ID 重建的新文件。改为事务 finalize，与后续写入严格串行。
3. **空 chunk ID 被当成未提供**：可能意外回退完整正文。改为用 `!== undefined` 判断参数是否提供。
4. **小详情升级分片时过早删除旧文件**：新分片写失败会导致旧小详情投影消失。改为先成功发布完整分片目录，再删除旧 `.md` 文件。

自动化验证由初版的 25 个测试文件、103 项测试，增加到当前 28 个测试文件、114 项测试；同时通过 typecheck、lint 和 build。大详情增量尚未重新执行真实 Host/模型分片冒烟，不能把这组自动化结果等同于新的真实环境验收。

## 14. 当前边界与后续演进方向

以下是当前限制或候选方向，不是已经实现的能力：

1. **长历史覆盖**：Review/蒸馏当前截取转录开头，后续可演进为持久游标、最新窗口或多段预算分配，避免长会话尾部长期未参与。
2. **全量整合覆盖**：整合有 64,000 字符输入预算，后续可增加分批整合和跨批合并计划，但不能牺牲 scope 与失败恢复。
3. **Refresh 再追加规则**：当前同 revision 永远 no-op；若需要“发送前多次点击不重复，但后续新对话后可再追加”，必须增加新的对话代际/注入时机语义，不能只放宽 revision 判断。
4. **变更后的刷新体验**：记忆 correct/forget 不会改写既有快照，生产 wiring 也未自动刷新已启用层；目前依赖手动 refresh 或后续新快照。
5. **召回质量**：当前没有查询相关性排序或向量召回。未来可在保留摘要索引和确定性权限边界的前提下增加可重建召回索引，而不是直接把所有详情塞入上下文。
6. **预算完整性**：当前 token 预算主要约束摘要条目，后续可把固定头、workspace 索引和尾部说明统一纳入最终快照预算。
7. **时间元数据健壮性**：无效 `lastVerifiedAt` 的展示和验证策略可进一步统一，避免快照出现无效年龄。
8. **模型调用韧性**：辅助模型已支持 AbortSignal 和可选 timeout，但蒸馏与整合调用方尚未设置统一默认超时，可补充明确超时和重试预算。
9. **安全入口收敛**：可把安全策略进一步下沉为所有生产写入都必须经过的用例层，减少未来新增入口绕过扫描的可能。

这些演进都应继续保持：父记忆单一事实源、scope 隔离、append-only Session、model-visible means logged、秘密最小化和可恢复写入。

## 15. 源码索引

| 主题 | 主要实现 |
|---|---|
| 数据模型、scope、revision、会话状态 | `src/store/types.ts`、`src/store/store.ts` |
| 原子 JSON、锁与 fencing | `src/store/json.ts`、`src/store/lock.ts` |
| 大详情切分与 Markdown 投影 | `src/store/chunks.ts`、`src/store/projections.ts` |
| 有效轮与生命周期调度 | `src/lifecycle/counters.ts`、`src/lifecycle/scheduler.ts` |
| 蒸馏、整合、遗忘 | `src/lifecycle/distill.ts`、`src/lifecycle/consolidate.ts`、`src/lifecycle/retention.ts` |
| 辅助模型调用与输出校验 | `src/lifecycle/llm.ts` |
| 秘密扫描、脱敏与来源准入 | `src/safety/` |
| 快照、提交对账与详情工具 | `src/context/snapshot.ts`、`src/context/service.ts`、`src/context/tool.ts` |
| API 与显式操作 | `src/api/` |
| 模块契约和演进记录 | `.qoder/plan/` |

阅读实现时，建议先以 `.qoder/plan/snail-memory-capability-map.md` 建立模块边界，再按“store → lifecycle/context → API/Web”的顺序追踪。各 Spec 描述验收契约，本文解释这些契约为何形成以及当前算法如何协作。
