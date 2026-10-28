# Snail Memory：记忆算法、设计技巧与演进

本文说明 Snail Memory 当前实现的记忆算法、关键方案取舍和演进过程。描述以 dsh `0.2.1-rc.3` 树外插件及 2026-10-28 的持久游标顺序蒸馏、大详情分片、父索引驻留、详情懒加载和独立 Global 记忆库实现为基线。

文中严格区分三类机制：

- **确定性算法**：计数、分片、ID 派生、revision、保留期、队列、提交对账等可重复验证的逻辑。
- **模型语义算法**：从对话提炼候选、语义去重、冲突裁决和旧结论取代，由辅助 LLM 完成。
- **宿主事实**：Session、turn、workspace 和模型历史归 dsh 所有，插件只通过公开扩展点读写获准的数据。

## 1. 设计目标与非目标

Snail Memory 解决的是单用户跨会话长期记忆，而不是再实现一套对话压缩器。它把少量稳定知识保存到 workspace 层，并允许用户把值得跨项目复用的条目显式 Promote 到独立 Global 记忆库。会话明确选择当前 workspace 或 Global 后注入对应摘要索引，模型再按需读取详情。

核心目标：

1. workspace 隔离权威写入；Global 只通过人工 Promote 深复制和自身整合维护，不动态汇总或自动同步所有 workspace。
2. 自动蒸馏与显式记住、纠正、提升、忘记并存。
3. 摘要优先、详情按需，大详情再按片读取，控制单次模型可见量。
4. 所有模型可见内容都有普通 Session 消息或工具结果作为证据。
5. 删除只影响目标 scope 的记忆，不删除、替换或压缩对话历史，也不影响来源或副本。
6. 重启可恢复，多 Host 不静默并发写，秘密不进入长期记忆和审计正文。

当前明确不采用向量数据库、embedding 召回或查询相关性排序，也不自动批量迁移、晋升或同步 workspace 记忆。Global 不是完整知识图谱或实时事实系统；旧记忆只是带来源时间的参考数据。

## 2. 总体算法视图

```text
真实用户 Session
      │
      ├─ 有效轮计数 ── 每 15 个完成轮 ──→ Review
      ├─ 活动停止 60 分钟 ──────────────→ Idle 蒸馏
      └─ archive / stop ────────────────→ Stop 蒸馏
                                             │
                                  共享 Session 事件游标取下一批
                                             │
                                  来源准入、扫描与脱敏
                                             │
                                    辅助模型生成候选
                                             │
                                  结构校验、输出安全回扫
                                             │
                              scope 内确定性去重与 upsert
                                             │
                              workspace dirty + 整合计划
                                             │
                         默认 20 小时后：逐 workspace 语义整合
                         每 24 小时：仅 workspace 保留期清理

workspace 详情 ── 人工 Promote 深复制 ──→ 独立 Global 条目
                                             │
                                Global dirty + 独立整合计划
                                             │
                              默认 7 天后：仅 Global 语义整合

两类 scope ──→ 父索引 JSON + 版本化详情 JSON + Markdown 投影
                                             │
                enable / refresh → 摘要索引快照 → append-only 注入
                                             │
                    snail_memory_read → 小详情 / 分片清单 / 单片
```

这条链路中，模型负责“理解什么值得记、哪些语义相同”，程序负责“能写到哪里、何时写、是否已提交、如何恢复以及不能泄露什么”。

## 3. 数据模型与分层

### 3.1 两种 scope

- `workspace`：自动蒸馏和显式记住/纠正的项目记忆权威来源。整合按 WorkspaceId 分别执行，保留期清理只处理这一层；Ungrouped 会话没有隐式 workspace，因此不会自动蒸馏到 Global。
- `global`：人工精选、独立维护的权威记忆库。用户只能从已注册 workspace 的条目执行 Promote；副本使用新 ID 和独立详情，以 `promotedFrom = { workspaceId, id }` 记录来源并幂等查重。复制后不随来源更新或删除，Global 自身删除也不反向影响来源。普通 remember/correct 仍不开放 Global 写入。

旧动态聚合不会批量复制到 Global，已有 workspace 数据保持不变；旧独立 Global 条目按权威记录恢复可见，但不会仅因格式升级自动发起 LLM 整合。旧聚合 revision 只用于一次性独立基线，此后 workspace 写入不再推进 Global revision。

WorkspaceId 是逻辑身份，canonical realpath 只用于归属校验，不作为记忆 ID。这样避免路径大小写、符号链接或目录解析变化直接重写记忆身份。

### 3.2 五类记忆

| 类别 | 用途 | 默认自动保留期 |
|---|---|---:|
| `preference` | 用户偏好 | 不自动过期 |
| `project-convention` | 项目约定 | 180 天 |
| `environment-fact` | 环境事实 | 30 天 |
| `troubleshooting` | 已验证排障经验 | 180 天 |
| `long-term-decision` | 重要长期决策 | 不自动过期 |

任何类别都可由有效 `expiresAt` 提前过期。保留期从 `lastVerifiedAt` 计算，而不是从创建时间计算，体现“最近重新验证过的事实可以延续”。Settings 中的五类 `retentionDays` 可以覆盖这些默认值，单位为天；`0` 表示关闭该类别的自动过期，但不屏蔽显式 `expiresAt`。修改后的策略从下一次每日清理开始生效。

### 3.3 父记忆是唯一实体

每条 `MemoryEntry` 包含稳定 ID、scope、类别、摘要、完整详情、创建/更新/最近验证时间、条目 revision、来源引用，以及可选的过期、取代和 `promotedFrom` 元数据。磁盘驻留时把它拆成父索引和版本化详情；`read()` 按 id/revision 读取详情后重新组成同一逻辑实体。

主索引不包含 `detail`，内部另存 `detailChars` 用于详情形态和完整性校验，不会把分片变成独立记忆。全局索引、workspace 索引、模型快照和 Web 管理页都围绕同一个父条目工作。

## 4. 生命周期触发算法

### 4.1 有效用户轮

只有满足以下条件才计入 Review：

1. 事件是 `user/message`。
2. `source.kind === 'user'`，排除 Snail Memory 注入、调度和 runtime context。
3. 所在 turn 最终以 `completed` 结束；aborted/error 不触发。
4. 同一 turn 的重复或乱序事件不重复计数。

计数器先关联用户消息与 turn，再处理“消息先于完成”和“完成先于消息”两种乱序。每完成 15 个有效用户轮安排一次 Review。

这个设计防止插件自己的记忆注入触发新一轮蒸馏，形成“注入 → 再总结 → 再注入”的自我强化循环。

### 4.2 三类蒸馏入口

| 入口 | 默认时机 | 转录输入预算 | 目的 |
|---|---|---:|---|
| Review | 每 15 个有效完成轮 | 24,000 字符 | 会话进行中的轻量提炼 |
| Idle | 最近活动后空闲 60 分钟 | 48,000 字符 | 对话暂停后的较完整提炼 |
| Stop | archive、session/agent stop | 48,000 字符 | 结束边界提炼 |

活动事件会刷新 idle intent 的创建时间，形成 debounce。三类入口最终复用同一个 `distillSession` 和同一份 Session 主进度，区别主要是输入预算、每次 intent 的最大批数和调度原因。Review 每次处理下一批；Idle/Stop 每次最多连续处理两批做有界追赶。后续 intent 从持久位置继续，因此长会话的中段和尾部可以最终参与，但单次维护不会退化成无预算全量回填。

管理页的 Settings 可以调整 `reviewEveryUserTurns`、`idleDelayMinutes`、`consolidationCooldownHours`、`globalConsolidationCooldownDays`、`snapshotTokenBudget` 和五类 `retentionDays`。默认值分别为 15 轮、60 分钟、workspace 20 小时和 Global 7 天，快照预算默认为 1,200 估算 token，保留期默认值见 3.2。所有值持久化到 `$DSH_HOME/snail_memory/settings.v1.json`，启动配置只作为文件缺失时的默认值；旧文件缺少新增字段时补用对应默认值，已显式保存的其他值保持不变。写入复用 MemoryStore 的单写者边界并采用原子替换，只读 Host 可读取但拒绝更新。保存成功后立即更新运行中的计数器和调度器：已有有效轮计数保留，已有 idle intent 按新延迟重新计算到期时间，workspace 与 Global 各自已有的 dirty/consolidation 计划分别按新的小时或天间隔从当前时间重排；保留期策略则由下一次每日清理读取。快照预算由两类 scope 共用，在后续 Enable/Refresh 创建新快照时读取，不改写已经生成的 desired 或已注入 Session 的历史快照。

蒸馏读取的是 Session 事件的确定性投影，不是原始 Session 的无差别副本。投影保留真实用户消息、助手消息和普通工具结果；其中 `snail_memory_read` 的 `tool/result` 通过 `tool/call.callId` 精确识别并排除，避免已保存的记忆详情再次成为蒸馏输入，普通工具结果仍作为工程证据保留。过滤只影响发给辅助模型的转录，原始 Session 中的工具调用与结果保持完整，模型当次按需读取详情的能力不变。

每个 Session 的可选 `distillationCursor` 只保存：

```text
lastEventSeq：最后已处理事件的稳定 eventSeq；同事件续片时保持该 seq
offset：该事件渲染文本中已消费的 UTF-16 code unit 数；完整事件结束后为 0
updatedAt：游标提交时间
```

初始位置为 `lastEventSeq = 0, offset = 0`。批选择从该位置之后开始，优先把同一 `turnId` 的完整事件组装入预算；装不下整个 turn 时按 eventSeq 和片内 offset 顺序切分。切分是确定性的，不为了语义美观丢字符或改写正文。游标只引用位置，不保存转录正文、秘密或异常原文；`state.v2.json` 的旧 Session 没有该字段时自然从初始位置开始，且只有实际生命周期触发才处理，不在启动时扫描旧 Session。

### 4.3 首次加载不做全量历史回填

插件首次加载只恢复已有记忆、调度和注入状态，不自动遍历并蒸馏全部历史 Session。首次 Enable 已有记忆层时生成并追加摘要快照，与历史回填是两种不同行为：前者让既有记忆可用，后者会从旧对话新提炼记忆，当前不默认执行后者。

不做自动全量回填的原因是历史结论可能过时，旧 Session 的 workspace 归属未必仍可验证，全量扫描还会放大辅助模型成本、秘密扫描范围和启动延迟。持久游标保证的是“被生命周期触发后的顺序覆盖”，不是启动时自动迁移全部旧知识，也不替代显式历史导入的范围确认与成本预算。

未来如确需历史回填，应提供显式导入操作，由用户选择 Session 或时间范围并确认目标 workspace，展示范围和预算，支持取消、断点恢复与幂等去重；不得把它变成 Host 启动时的隐式全量任务。

### 4.4 单 timer 与持久 intent

调度器只保留一个必要 timer，所有任务串行执行。`meta.pending` 持久化 Review、Idle、Stop、workspace `consolidate`、独立 `global-consolidate` 和 Retention 意图；重启后根据各自时间恢复到期任务。

- workspace 有实际写入时设置 `dirty`，默认将整合安排在 20 小时后；Global 新建、修改或删除只设置 `globalDirty`，默认独立安排在 7 天后。
- 两类整合都只在各自 dirty 且到期时运行，成功清理、失败重试和设置热更新不互相清除或重排对方状态。
- 保留期清理默认每 24 小时运行，只枚举 workspace scope。
- Review/Idle/Stop 只写 Session owner workspace，不改变 Global dirty 或调度；Review/Stop 失败后降级为 Idle 意图，空闲类任务按 60 分钟重试。
- 两类整合和保留期失败分别按各自周期重试。
- 卸载停止新 timer，但等待已经进入队列的工作 drain。
- 错误状态只保存稳定类别，不保存可能包含路径、提示词或秘密的异常正文。

## 5. 蒸馏与确定性去重

### 5.1 蒸馏管线

```text
限定 Session 来源
  → 从共享游标选择预算内下一批
  → 扫描并脱敏；拒绝不可接受内容
  → 要求辅助模型只返回 JSON candidates
  → 校验类别、summary、detail 和 16,000 字符详情上限
  → 回扫模型输出，剔除不安全候选
  → 在当前 workspace 内匹配旧记忆
  → upsert/去重、合并 sourceRefs 和 lastVerifiedAt
  → 有写入则标记 dirty
  → 通过主 Store writer 提交新游标
```

模型输出上限为 64,000 字符，对应调用预算 16,000 max tokens。没有可用模型路由时明确失败并保留可重试状态，不生成虚假记忆，也不伪造整合成功。

游标采用**至少处理一次**语义，提交顺序始终是“模型成功响应并解析 → 候选安全校验 → 写入或确定性去重 → 游标提交”。空候选和被安全策略完整拒绝的候选都属于已可靠处理，可以推进；是否有新增记忆不是推进条件。路由缺失、请求失败/取消/超时、输出不可解析、输入安全拒绝或存储失败都不推进。

如果记忆状态已提交而游标提交前进程崩溃，重试会处理同一批。稳定 ID 和相同内容去重避免新增重复条目；相同记忆来自新批次时合并 Session/eventSeq sourceRefs，既有语义整合继续处理措辞不同的近义候选。这个窗口允许重复模型调用和重复候选处理，以换取不丢历史；绝不先推进游标再处理。

### 5.2 稳定 ID

自动蒸馏的新候选使用：

```text
scopeKey = workspaceId
normalizedSummary = summary.trim().toLowerCase()
memoryId = SHA256(scopeKey + NUL + category + NUL + normalizedSummary)
```

写入前还会在当前 scope 内查找“同类别且规范化 summary 相同”的旧条目。完全相同的 summary、detail 和 sourceRefs 不重复写入；内容或来源引用改变时沿用旧 ID 并更新 revision，eventSeq 按 Session 合并去重。

这个 ID 不是语义相似度哈希。措辞不同的同义记忆仍需要后续 LLM 整合；scope 和 category 参与哈希则防止跨层、跨类别误合并。

### 5.3 人工 Promote 是事务内深复制

Promote 只接受已注册 workspace 的来源条目。Store 在同一串行写事务中按 `promotedFrom = { workspaceId, id }` 查重、读取来源当前权威详情、生成新的 Global ID，并完整写入新详情世代和投影；UI 禁用按钮只改善交互，不能替代 Host 幂等。

副本保留类别、摘要、正文、sourceRefs 和内容时间语义，但获得自己的 createdAt/updatedAt/revision；来源 `supersedes` 不复制，避免产生跨 scope 悬空引用。重复或并发 Promote 在副本仍存在时返回同一个 ID，不推进 revision、不设置 dirty；删除副本后再次显式 Promote 则允许创建新副本。Promote 不修改 Session、蒸馏游标或来源条目，后续来源 correction、retention、supersedes 和删除也不会自动同步到副本。

## 6. 整合与冲突裁决

整合严格按 scope 隔离：workspace intent 逐项目处理，Global intent 只处理独立 Global 条目，不把来源 workspace 或其他项目装入同一次模型输入，也不自动晋升。每个目标 scope 的处理过程为：

1. 按 `updatedAt` 从新到旧排列完整条目。
2. 逐条装入最多 64,000 字符的模型输入；达到预算后停止加入更老条目。
3. 要求模型在当前 scope 内合并重复、修正冲突、淘汰旧结论，返回 candidates 和可选 `supersedes`。
4. 确定性代码只接受当前 scope 已存在的候选 ID；未知 ID 不用于跨 scope 移动。
5. 合并并按 JSON 精确值去重 `sourceRefs`，写回新 revision，再删除同 scope 中被取代的旧 ID；Global 写回保留 `promotedFrom`。
6. 全部成功后只清理目标类的 dirty、pending 和下次整合时间，并记录对应的最近整合时间。

因此，“语义上是否重复、哪个结论更新”是模型判断；“是否允许写、能否跨 scope、如何持久化和删除”是程序判断。这个分工让语义能力可演进，同时把数据安全边界留在确定性代码中。

为限制模型等待期间的写回竞态，候选会关联调用前的条目快照，写前重新读取并核对条目 revision；已删除或已纠正的条目不再接受旧候选。最终清理也只在对应 next consolidation 时间仍等于调用前计划时执行，避免旧任务清除运行期间新 Promote/Delete 建立的 dirty 和重排计划。这些防护不是完整的条件写事务：`store.read()` 与后续 `store.upsert()` 之间仍存在很小的交错窗口，彻底关闭需要在该 Store 写事务内校验 expected revision 或提供等价条件写。

整合同样是预算内批处理，不保证每轮让所有历史条目都参与。首条本身过大时只会截取其 detail 以形成降级输入。

## 7. 遗忘算法

遗忘分为 workspace 自动保留期清理和两个 scope 各自的显式忘记。Global 不参与每日 retention，即使条目带有显式 `expiresAt`，也不会被该任务自动删除。

workspace 自动过期判断：

```text
若 expiresAt 有效且 expiresAt <= now：过期
否则若该类别的 retentionDays = 0：不过期
否则若 lastVerifiedAt 无效：过期
否则若 lastVerifiedAt + retentionDays <= now：过期
```

显式忘记按 `scope + id` 精确删除，不跨 scope 搜索，不调用模型。删除会推进目标 scope revision、移除权威条目和详情投影，并只安排该类 scope 的后续整合。删除 Global 副本不删除来源 workspace 条目，删除来源也不删除已 Promote 的 Global 副本。

无论哪种遗忘，都不修改 dsh Session，也不修改任何 Session 蒸馏游标。MemoryEntry 删除与“历史已处理到哪里”是正交事实：删除一条或全部记忆不会回退、重置或推进游标，不会让对应历史重新进入蒸馏，也不会借游标恢复已删条目。已经注入的旧快照仍是历史事实，只是不会再出现在未来快照中，且对应详情不再可读。只有宿主真实 Session 生命周期清理才可另议游标垃圾回收，不能复用 UI 删除记忆按钮的语义。

## 8. 召回、快照与注入

### 8.1 召回不是向量搜索

当前召回策略是“所选层摘要索引 + 按 ID 精确读取”：

1. Store 按 `updatedAt` 新到旧排列，ID 作为稳定次序兜底；Global 只枚举独立 Global 父索引，不汇总 workspace。
2. enable 或 refresh 时渲染所选层摘要索引。
3. Global 快照只包含预算内的独立 Global 摘要，不包含 workspace 引用统计；两类快照都不读取或注入完整详情。
4. 模型确有需要时调用 `snail_memory_read`，提供已启用 layer 和父 memory ID；Store 此时才按当前 scope 的 id/revision 异步读取目标权威详情记录，Global 不再要求来源 `workspace_id`。
5. 小详情直接返回；大详情先返回分片清单，再按 chunk ID 读取单片。

每条快照记忆带类别、ID、摘要和“若干天前”的时点提示，并明确它是不可信参考数据，不能覆盖当前用户、系统或安全指令。

### 8.2 快照预算

Token 使用启发式估算：

```text
estimatedTokens(text) = ceil(text.length / 4) + 8
```

默认摘要条目预算为 1,200 估算 token，可通过 Settings 的 `snapshotTokenBudget` 调整并持久化，workspace 与 Global 共用该值。Context 在每次 Enable/Refresh 创建新快照时读取当前值；已有 desired 和已注入 Session 的历史快照保持不变。超限后停止加入后续条目，并提示还有条目可按 ID 读取。该估算不是 provider 的精确计费值；固定头和尾部说明也不属于当前条目循环的硬上限。

### 8.3 关闭 / workspace / 全局三态单选

新会话默认关闭。enable(global) 或 enable(workspace) 会原子地选中目标并取消另一层；disable 同时关闭两层。workspace 下拉框可选择任意已注册项目，不限于 Session 所属项目，Ungrouped 会话也可显式选择。Host 和 Composer 都以这份状态为准；旧数据若两层同时 enabled，恢复时以 workspace 为选中层。

Session `workspaceId` 与 `selectedWorkspaceId` 分工不同：前者是自动蒸馏和显式写入的 owner，后者只决定 workspace 快照、详情读取与 refresh。召回其他项目不会改变蒸馏归属，也不会给 Ungrouped 会话增加隐式写入 owner。

每个 Session 同时最多一个 `activeDesired = { layer, injectionId }`。只有重复选择当前层且召回项目相同才幂等恢复；切换到另一层或另一 workspace 时按目标 scope 当前 revision 创建新代并移动 active 指针，disable 则清空 active。历史 desired/committed 仅保留作对账和审计记录，不再分别具有待注入资格。

“只加载一次”指自动注入次数，不禁止用户显式 refresh。当前 refresh 只允许所选层，并且仅在当前 scope revision 高于该 scope 已有 desired 最大 revision 时创建新快照，否则恢复 active 注入并返回 up-to-date。不同 workspace 的 revision 是独立序列，不得跨项目比较。同一发送前多次切换或 refresh 只保留最新 active 快照，未提交的旧代会从 Inbox 撤回；已提交快照不受影响。

### 8.4 desired → queued → admitted → committed

`agent.inject()` 返回不代表消息已经持久化，因此插件把注入拆成四个事实：

```text
desired：快照、injectionId、revision 与唯一 active 指针已原子持久化
   ↓ restore / agent.inject
queued：本进程已将快照放入 Host Inbox，并记录 queued 标记
   ↓ agent/pre-step 在最终 enter decision 中准入
admitted：记录本 turn 实际允许进入模型的 injectionId
   ↓ 观察到匹配的 post-commit user/message
committed：记录 injectionId、revision、提交时间和估算 token
```

- restore 先扫描 Session 已提交的 Snail `user/message`，再通过公开 `agent.inbox.replace/remove` 收敛未 claim 消息：保留一个 active 快照，移除 stale/duplicate 快照，缺少 active 时才调用 `agent.inject()`；普通用户和其他插件消息不变。
- pre-step 必须先等待下游 decision，再过滤 Snail 快照。每个 turn 最多准入一份 active 快照，后续 step 不得再准入第二份；同 turn 被过滤的新 active 在 agent 回到 idle 后重新 restore。
- post-commit 只提交 pre-step 实际记录的 admitted ID。若 pre-step 后发生切换或 refresh，旧 admitted 代仍如实 committed，新 active 代保持 pending，不能把新代误记为已注入。
- 重启后只恢复 active desired，而不是重新计算并恢复全部 `desired - committed`。可写 Host 会从 Session 历史补齐崩溃窗口内尚未落盘的 committed；只读 Host 也用该历史抑制重复注入，但不尝试写状态。
- 重复事件不重复累计 committed 或 token；被宿主 discard 的消息只释放 queued 标记，允许以后重试。
- 已提交快照和 committed 历史永不 replace 或追溯改写，删除记忆也不撤回既有对话；token 统计只计算 committed，不把“按钮已点击”当成“模型已经看见”。

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

默认数据根为 `$DSH_HOME/snail_memory`。当前权威存储由父状态和其指向的详情世代组成，Markdown 只是投影：

```text
state.v2.json                         父索引、Session、调度状态；不含完整 detail
detail-data/<id>/<revision>.json     不可变权威详情；父索引的 revision 选择当前世代
details/<id>.md                      小详情可读投影
details/<id>/part-NNN.md             大详情分片可读投影
global/、workspaces/                 INDEX.md 与 MEMORY.md 索引投影
```

Host 启动只读取 `state.v2.json` 到 `MemoryStore`。`list()`、`enable()` 和 `refresh()` 都消费这份内存父索引；只有 `read()`、生命周期中确需正文的整合/去重，以及 UI/工具的详情请求才读取目标详情记录。因此详情懒加载减少的是启动读取、JSON 解析和常驻内存，不改变既有模型召回方式。

首次可写启动发现旧 `state.v1.json` 时，先把内联详情写成版本化记录并生成详情投影，再原子发布 v2，全部成功后才删除 v1。只读实例遇到尚未迁移的 v1 时使用兼容读取；它不执行迁移或删除旧文件。

关键技巧：

- 所有 CRUD、Session 状态、蒸馏游标和调度元数据进入同一串行写队列；游标复用 `updateSessionState` 的 `lock.assertOwner()`/fencing 与原子恢复边界，不新增独立写入队列。writer 的单条详情读取也进入该队列，避免读取与纠正、删除竞争。
- 游标-only 事务只更新 Session 位置元数据：不推进记忆 scope revision、不设置 dirty、不创建 desired injection 或新快照，也不触发整合。
- 新详情先写入 `detail-data/<id>/<newRevision>.json`，对应详情 Markdown 也完整发布成功后，才原子切换 `state.v2.json`；这些步骤失败时父 revision 不前进。
- 每次事务先持久化只含受影响父 id 的 `projection-pending.v1.json`。提交前失败按当前父状态尝试恢复旧投影，恢复本身失败时保留 intent；崩溃或提交后派生失败同样保留 intent，由下次可写启动或后续事务按父状态重建详情和索引、清理未引用记录，再删除 intent。
- 父状态发布后立即更新内存，再写 INDEX/MEMORY 投影和清理旧详情世代。派生失败不能把内存回退到旧权威状态，也不能把已提交操作误报为未提交。
- 权威 JSON、小详情和 INDEX/MEMORY 均原子替换；读取时校验记录 id、revision 和 `detailChars`，损坏或缺失不错误回退到其他正文。
- 同一 root 使用独占锁、heartbeat、stale 判定和 writer fencing；第二 Host 初始明确只读，但持续监控锁释放或 stale，完成权威状态重载与投影恢复后可自动晋升为唯一 writer。stale 回收先把观察到的旧锁移入唯一 quarantine 并逐字核对，误移新锁时用硬链接恢复；锁缺失时可恢复崩溃遗留的 quarantine，主锁已存在时则清理过期 quarantine，避免反复移走当前锁形成获锁活锁。writer 通过本代 FileHandle 续心跳，旧 writer 不能沿路径覆盖继任锁。活跃 writer 心跳有效时不允许接管。只读 Host 在详情读取前刷新 v2 父状态，记录 ENOENT 时再刷新重试，以观察另一 Host 已提交的纠正和删除。
- writable 变化会通知 Host 运行时：失去所有权时暂停 lifecycle，晋升后恢复当前 agents 状态并重启 lifecycle；首次和后续准备或启动失败都在当前可写期间自动重试。锁晋升与 heartbeat 解耦，初始化、迁移和投影恢复在各共享写入阶段续租并验权。Store 事务把可识别的所有权/fencing 异常统一归为只读错误，scheduler 因此能暂存验权竞争期间收到的新 intent；普通 I/O 和编程错误不按只读吞没。scheduler 的 stop 只暂停且保留持久 intent，暂停或只读期间收到的新 intent 也会暂存并在可写启动后落盘；start 提交固定快照，只清理本次已持久化且未更新的条目，不能用 clear 误删提交期间新增的 intent。dispose 才永久终止。卸载会停止锁监控、重试并清理 timer。
- Windows 原子 rename 的短暂 EPERM 使用有限退避，不无上限重试。
- 大详情先在同级临时目录写完整套分片，再切换目标目录；失败恢复旧目录，后续投影清理临时/备份残留。
- 纠正导致缩片、大小形态切换或删除时清理旧投影；纠正发布后清理旧权威详情世代。
- 删除收尾也位于同一事务队列内，避免“旧删除任务”误删随后同 ID 重建的新记录或分片。

这里有两个核心不变量：父状态只能指向已经完整写入的详情世代；任何时刻都不能把半套新分片和半套旧分片当成一个可用版本。启动只重建 INDEX/MEMORY，不为了刷新所有人类详情投影而重新全量读取正文。

## 12. 关键设计技巧与方案取舍

### 12.1 把语义判断与系统不变量分开

LLM 适合提炼、同义合并和冲突解释，不适合承担权限、事务、权限 scope、提交确认和删除顺序。插件让模型产出候选，再由确定性代码决定是否接受。

### 12.2 用单一权威状态派生多种视图

权威 JSON 同时服务 Host、Web 和恢复；Markdown、主索引和分片目录都是投影。这样纠正或遗忘只需改变一个事实源，避免 JSON 与文档各自演化后互相矛盾。

### 12.3 用 revision 驱动显式刷新

每个 workspace 和独立 Global 都只在各自实际 upsert/remove/promote 时推进自己的 revision；Session 状态更新不会推进记忆 revision。旧动态聚合的 Global revision 在首次加载旧格式时转为一次性独立基线，避免既有 Global 快照让首次 Promote 后的新 revision 被误判为 up-to-date。刷新基于当前 scope 的 revision，而不是比较整段 Markdown，因此重复点击和进程恢复可以使用稳定规则判断是否需要新快照。

### 12.4 用 append-only 换取可审计性

替换旧 system prompt 或旧记忆消息虽然可能减少历史 token，却会破坏前缀稳定性、事实可重建性和删除边界。Snail Memory 选择追加快照，让每次模型可见变化都有历史证据。

### 12.5 把“已排队”和“已提交”分开

如果只用按钮状态或 inject 返回值判断成功，重启、discard 和重复事件都会造成丢失或重复注入。持久 desired 加 post-commit 对账，才能把 UI 反馈、队列状态和模型可见事实区分开。

### 12.6 先限制读取，再限制写入

上下文成本不仅来自常驻摘要，也来自工具一次性返回的大对象。先采用“摘要索引 + 按 ID 详情”，再演进为“分片清单 + 单片”，是在不改变记忆实体和 Session 格式的情况下逐层收紧读取预算。

### 12.7 用失败注入验证真正的不变量

正常 CRUD 测试无法发现目录写一半、旧删除误删新文件等竞争。针对这些风险，测试注入指定分片写失败和受控删除延迟，分别证明旧整套投影保留、删除与重建不会串序。

### 12.8 用持久位置换取顺序覆盖，用重复窗口换取不丢历史

固定前缀截取的实现最简单，但会让每次 Review/Idle/Stop 重复总结同一段历史，长会话中段和尾部永远没有输入机会。持久 eventSeq 游标把进度变成 Session 的权威元数据；片内 offset 又避免超大消息因无法整批装入而永久卡住。取舍是需要承受“记忆已写、游标未写”的崩溃重复窗口，并用幂等写入而不是先推进位置来控制它。

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

自动化验证由初版的 25 个测试文件、103 项测试，增加到大详情阶段的 28 个测试文件、114 项测试；同时通过 typecheck、lint 和 build。大详情增量尚未重新执行真实 Host/模型分片冒烟，不能把这组自动化结果等同于新的真实环境验收。

### 阶段六：从全量状态驻留演进为父索引驻留

初版启动把 `state.v1.json` 中的所有完整正文读入内存，虽然 enable/refresh 只使用摘要，但详情数量增长仍会放大启动 I/O、JSON 解析和常驻内存。v2 将父索引与不可变详情世代分开：正常启动、list 和快照生成只消费父元数据，只有明确的详情读取、整合或 UI 请求才按 id/revision 读取目标正文。

这次演进没有改变模型召回、分片契约或 Session 格式，但把多文件一致性变成核心问题。最终实现以父状态提交为边界，配合版本化详情、只含 id 的投影恢复 intent、提交前回滚、提交后重试和读写串行化；第二 Host 通过刷新父状态观察纠正与删除，保留期清理也不再逐条读取正文。

该增量实际通过 28 个测试文件、124 项测试，以及 typecheck、lint 和 build。未重新执行真实 Host/UI/模型验证，因此这些结果证明的是自动化契约与故障注入边界，不等同于新的真实环境验收。

### 阶段七：从独立全局存储演进为动态聚合与互斥注入

全局不再接受独立 remember/correct/forget，也不再只显示 workspace 引用。Store、Markdown、快照和 Web 统一从所有 workspace 的当前权威条目生成全局视图，详情按原 scope 和来源 workspace 读取；旧 global 数据仅为兼容保留，不参与展示或后台维护。自动蒸馏、整合和保留期仍只处理 workspace。

Session 从两个独立 enable latch 演进为“关闭 / 当前 workspace / 全局”三态单选，新增 disable RPC，并在 Host 侧原子互斥和归一化旧双层状态。切换只影响后续恢复与新注入，既有 Session 快照仍遵守 append-only。

### 阶段八：从固定前缀演进为持久游标顺序覆盖

Review/Idle/Stop 不再分别截取转录开头，而是共享每 Session 的 eventSeq/片内 offset。完整 turn 优先整批处理，超大 turn 和消息可确定性地跨批续接；Review 每次一批，Idle/Stop 每次最多两批。游标在候选可靠处理后由主 Store writer 提交，重启恢复与至少一次重复窗口均有自动化契约覆盖。

该增量的自动化验证覆盖顺序推进、三入口去重、空候选、安全拒绝、失败不推进、重启、崩溃重复、长会话尾部、大 turn/消息、scope 隔离、sourceRefs 合并，以及删除单条/全部后的游标正交性。未安装到真实 Host，也未调用真实模型；真实 Session 事件形态、维护调度和模型时延仍需隔离环境验收。

### 阶段九：快速重启后的只读锁自动恢复（Issue 2026-10-28）

真机快速重启 dsh 后，点击 Enable 报 `Snail Memory is read-only on this host.`。现场时间线显示旧锁最后心跳早于新 Host 启动约 10 秒：新 Host 启动时旧锁尚未超过 30 秒 stale 阈值，因此按单写者规则进入只读；旧锁随后过期，但旧实现只在启动时检查一次，运行期间没有重取锁机制，导致永久只读。该问题与全局动态聚合无关，也不能通过允许多 writer 或盲目删锁解决。

修复后，同一个锁监控周期在 writer 身份下续心跳，在只读身份下重试获取。锁释放或 stale 后，候选 Host 先重载最新权威状态、执行 v1 兼容迁移或 pending 投影恢复，再发布 writable 并通知运行时启动 lifecycle；失去所有权则暂停 lifecycle。scheduler 区分可恢复的 stop 与最终 dispose，暂停或只读期间收到的新 intent 不再直接丢弃，首次及后续 Host 准备 agents 或启动 lifecycle 的瞬时失败也会在当前可写期间重试。

并发复核进一步固定了三个容易在 happy path 中漏掉的边界：两个 Host 同时回收同一 stale 锁时，只有移出内容仍与此前观察逐字一致的回收者才能继续，误移新锁必须恢复；writer 心跳写入本代 FileHandle，不能覆盖继任锁；晋升恢复与锁监控解耦，恢复期间仍持续 heartbeat，且各共享写入阶段重新验权。崩溃遗留的 quarantine 在锁缺失时通过硬链接恢复，不需要人工删锁。

追加复核又覆盖了四种交错：主锁与遗留 quarantine 同时存在时，主锁是当前事实，旧 quarantine 必须清理，不能反复恢复并移走主锁；writable 检查后的 fencing 失败由 Store 事务统一归类为只读，scheduler 暂存 intent 并在重新晋升后补持久化，其他异常不吞没；首次 lifecycle 启动与后续晋升共用 WriterLifecycleRuntime，因此首次瞬时失败也不会使插件直接卸载或失去重试；start 提交 deferred 快照期间新增的 intent 不参与本次清理，只有快照中已持久化且未更新的条目才能删除。

回归测试覆盖快速重启、活跃 writer 保护、并发 stale 接管、quarantine 崩溃恢复与并存清理、旧 heartbeat 隔离、晋升期间持续心跳、正常释放后的状态重载、lifecycle 暂停/恢复、首次及后续启动失败重试、只读和 fencing 竞争事件补持久化，以及启动提交期间的 deferred intent 保留。最终自动化结果为 31 个测试文件、179 条测试，并通过 typecheck、lint 和 build；真实定时器的隔离 Temp 目录冒烟同时验证了 stale 晋升与正常释放后的第二次接管。未通过重新安装或重启用户真实 Host 做验收。

### 阶段十：从双层独立 pending 演进为 Session 级单快照协议

三态单选只限制了 enabled 状态，旧实现仍让两层各自的未完成 desired 都具有恢复资格，因此切换层、连续 refresh 或重启对账时可能叠加多份快照。此次修复把不变量收敛为：每个 Session 同时最多一个 active desired，每次 pre-step 最多准入一份 Snail 快照，每次用户提交最多新增一条 committed；历史 committed 保留且不追溯改写。

enable、切换和 refresh 在 Store 事务中移动唯一 active 指针。restore 先按 Session 历史对账，再用公开 Inbox replace/remove 收敛未 claim 的 stale/duplicate 快照；pre-step 等待下游 decision 后执行最终准入过滤，并记录实际 admitted ID，post-commit 只提交该 ID。这样 pre-step 后的切换或 refresh 不会把新代误记为已提交，同 turn 后续 step 也不会准入第二份；被推迟的新代在 agent 回到 idle 后恢复。

重启对账覆盖“Session 已提交、插件 committed 尚未落盘”的崩溃窗口：可写 Host 补齐 committed，只读 Host 仅据 Session 历史抑制重复注入。自动化契约覆盖层切换、连续 refresh、重复 enable、disable 撤回、提交竞态、同 turn 延迟、普通与下游消息保留、重启、重复通知和只读恢复。该增量全量自动化结果为 31 个测试文件、187 条测试，并通过 typecheck、lint 和 build。语义近重复仍属于独立的记忆内容去重问题，不由注入协议伪装解决；本增量未重新执行真实 Host/UI/模型验收。

### 阶段十一：从当前项目召回演进为可选 workspace 召回

此前 Composer 虽能列出其他 workspace，却只允许启用 Session 所属项目，Host 也没有独立保存召回选择。此次演进让 enable(workspace) 接受任意已注册 workspace id，Ungrouped Session 同样可显式选择；已启用 A 时可直接切换 B，只有当前层且召回项目相同的重复 enable 才幂等返回。

存储把 Session `workspaceId` 与 `selectedWorkspaceId` 分开：前者继续作为自动蒸馏和显式写入 owner，后者只服务快照、refresh 和详情读取。因此召回其他项目不会把后续对话蒸馏到该项目，也不会给 Ungrouped 增加隐式写入归属。workspace 切换仍移动唯一 active desired，不增加第二份 pending 快照，既有 committed 历史保持不变。

不同 workspace 的 revision 是独立序列。workspace desired/committed 新增可选 `workspaceId`，refresh 和公共 Session 状态只按当前召回项目对账，避免 A 的较高 revision 让 B 的新记忆被误判为 up-to-date。旧版缺省该字段的 workspace 记录按 Session owner 解释；切到其他项目时不会误算，回到 owner 或读取旧状态时也不会漏算 revision。global 动态聚合及 committed token 的全 Session 统计不变。

自动化契约覆盖非当前项目与 Ungrouped 启用、RPC 参数校验、A→B 单 active 切换、跨项目详情读取、owner 不变、重复启用、独立 revision 刷新，以及旧版无项目字段记录的 refresh 和公共状态兼容。该增量全量自动化结果为 31 个测试文件、194 条测试，并通过 typecheck、lint 和 build；未重新执行真实 Host/UI/模型验收，也未安装到真实 Host 或重启用户进程。

### 阶段十二：从动态聚合演进为人工精选的独立 Global

动态聚合让任一 workspace 的条目都自动进入 Global，无法在全局层独立取舍、删除或整合，也让 workspace 变化持续影响 Global 快照。此次演进把 Global 改为独立权威 scope：只有用户在 workspace 详情中显式 Promote 才创建副本，Global tab、快照和工具读取都不再汇总 workspace，也不要求来源 `workspace_id`。

Promote 在 Store 事务内完成幂等查重和深复制，使用新 ID、独立权威详情和 `promotedFrom`；长正文沿用现有版本化记录与确定性分片。副本与来源双向隔离，重复 Promote 不增加 revision，删除后再次显式 Promote 可以重建。旧动态聚合不批量迁移，旧独立 Global 条目恢复可见，旧聚合 revision 只转为一次性独立基线，避免首次新写入无法 Refresh。

Global 新增独立 `globalDirty`、`nextGlobalConsolidationAt`、`lastGlobalConsolidationAt` 和 `global-consolidate` 持久 intent，默认 7 天执行一次 dirty 整合；workspace 仍默认 20 小时并逐项目隔离。两者共用单 timer、串行队列和快照 token 预算，但 dirty、成功、失败、重试和热更新互不影响。Review/Idle/Stop 仍只写 Session owner workspace，retention 仍只清理 workspace，Promote/Delete 仍不触碰 Session 或蒸馏游标。

自动化契约覆盖独立列表与 revision、并发 Promote、长正文分片、双向隔离、旧基线、独立调度与重试、Global 单 scope 整合、API/工具/界面和游标正交。独立复核后又增加慢模型回归，覆盖模型等待期间删除后旧候选不复活，以及旧整合或 Scheduler 任务不清除运行期间新 Promote/Delete 建立的 Global dirty 和重排计划；命令中过时的“只读聚合”文案也同步修正。

该增量全量自动化结果为 31 个测试文件、205 条测试，并通过 typecheck、lint、build 和 `git diff --check`。整合的 `store.read()` → `store.upsert()` 尚未形成同事务 expected-revision 条件写，极小交错窗口仍作为已知边界保留，不能宣称复核发现已全部关闭。本轮未重新执行真实 Host/UI/模型验收，也未安装到真实 Host、重启用户进程或创建 git commit。

## 14. 当前边界与后续演进方向

以下是当前限制或候选方向，不是已经实现的能力：

1. **显式历史 backfill**：持久游标只服务正常生命周期触发，不会首次启动自动扫描全部旧 Session；如需迁移旧知识，仍需显式选择范围、独立预算、取消和恢复方案。
2. **全量整合覆盖**：整合有 64,000 字符输入预算，后续可增加分批整合和跨批合并计划，但不能牺牲 scope 与失败恢复。
3. **Refresh 再追加规则**：当前同 revision 永远 no-op；若需要“发送前多次点击不重复，但后续新对话后可再追加”，必须增加新的对话代际/注入时机语义，不能只放宽 revision 判断。
4. **变更后的刷新体验**：记忆 correct/forget 不会改写既有快照，生产 wiring 也未自动刷新已启用层；目前依赖手动 refresh 或后续新快照。
5. **召回质量**：当前没有查询相关性排序或向量召回。未来可在保留摘要索引和确定性权限边界的前提下增加可重建召回索引，而不是直接把所有详情塞入上下文。
6. **预算完整性**：当前 token 预算主要约束摘要条目，后续可把固定头和尾部说明统一纳入最终快照预算。
7. **时间元数据健壮性**：无效 `lastVerifiedAt` 的展示和验证策略可进一步统一，避免快照出现无效年龄。
8. **模型调用韧性**：辅助模型已支持 AbortSignal 和可选 timeout，但蒸馏与整合调用方尚未设置统一默认超时，可补充明确超时和重试预算。
9. **安全入口收敛**：可把安全策略进一步下沉为所有生产写入都必须经过的用例层，减少未来新增入口绕过扫描的可能。
10. **整合原子条件写**：当前已用调用前快照、写前 revision 复核和调度时间代际判断缩小竞态，但 `store.read()` 与 `store.upsert()` 之间仍可发生删除或纠正交错。后续应在 Store 同一写事务内校验 expected revision，或提供等价条件写；在此之前不能承诺慢模型期间的所有并发写回都已隔离。

这些演进都应继续保持：父记忆单一事实源、scope 隔离、append-only Session、model-visible means logged、秘密最小化和可恢复写入。

## 15. 源码索引

| 主题 | 主要实现 |
|---|---|
| 数据模型、scope、Promote、revision、会话状态 | `src/store/types.ts`、`src/store/aggregate.ts`、`src/store/store.ts` |
| 原子 JSON、锁与 fencing | `src/store/json.ts`、`src/store/lock.ts` |
| 版本化权威详情与按需读取 | `src/store/records.ts`、`src/store/store.ts` |
| 大详情切分与 Markdown 投影 | `src/store/chunks.ts`、`src/store/projections.ts` |
| 有效轮与生命周期调度 | `src/lifecycle/counters.ts`、`src/lifecycle/scheduler.ts` |
| 蒸馏转录投影、turn 组批与片内游标 | `src/runtime.ts` |
| 蒸馏、整合、遗忘 | `src/lifecycle/distill.ts`、`src/lifecycle/consolidate.ts`、`src/lifecycle/retention.ts` |
| 辅助模型调用与输出校验 | `src/lifecycle/llm.ts` |
| 秘密扫描、脱敏与来源准入 | `src/safety/` |
| 快照、提交对账与详情工具 | `src/context/snapshot.ts`、`src/context/service.ts`、`src/context/tool.ts` |
| API 与显式操作 | `src/api/` |
| 模块契约和演进记录 | `.qoder/plan/` |

阅读实现时，建议先以 `.qoder/plan/snail-memory-capability-map.md` 建立模块边界，再按“store → lifecycle/context → API/Web”的顺序追踪。各 Spec 描述验收契约，本文解释这些契约为何形成以及当前算法如何协作。
