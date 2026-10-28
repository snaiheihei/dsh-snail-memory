# Snail Memory 能力地图

## 目标与基线

为 DeepSeek Harness 设计单用户、全局与 workspace 分层的长期记忆插件。本文只确定模块边界、依赖方向和建设顺序，不进入实现。

源码基线：`1f81c047fc48fa190a683e469daa699857e9afe8`，包版本 `0.2.1-rc.3`。

## 设计假设

1. 存储根目录由插件 Config 调用 `resolveDshHome(configuredHome)` 后解析 `snail_memory`，默认即 `~/.dsh/snail_memory`，同时尊重显式 dsh home 和 `DSH_HOME`。
2. 在独立仓库 `dsh-snail-memory` 实现一个带 Host 与 Client half 的树外 bundle 插件，通过 `dsh plugin --profile web add <path>` 安装；不得修改 dsh 产品源码、bundle、Remote 注册表或生成目录。
3. 全局记忆与 workspace 记忆在每会话中采用关闭/workspace/global 三态单选，同时最多启用一层；新会话默认关闭，可 disable、重新 enable 或切换层与召回项目。
4. “只加载一次”指每次启用当前选择只生成一个自动快照代；重复 enable 同一层和同一 workspace 不创建新代。disable 后重新 enable 可创建新自动快照代，refresh 则是显式操作，可在目标 scope revision 变化时再次追加。
5. “摘要常驻”指已启用层的摘要和索引进入该会话派生历史；并非对所有新会话无条件注入。详情通过受限记忆读取工具或 UI 按需读取。
6. 全局层是人工精选的独立权威记忆库。用户可从 workspace 详情显式 Promote，深复制索引与完整正文；副本与来源隔离，不动态聚合、不自动同步或批量晋升。
7. Ungrouped 会话不创建隐式 workspace 写入归属，也不会因召回选择自动获得 owner；可显式使用 Global，或选择任意已注册 workspace 做召回，不自动蒸馏到全局层。
8. UI token 数使用 dsh token-meter 的启发式估算并明确标注，不宣称等于 provider 计费值。
9. 删除和忘记只修改 snail memory；不删除、替换或压缩原始 Session。已经注入的记忆快照仍是该会话历史，不做追溯撤回。
10. 同一存储根同时只允许一个写 Host；其他进程只读并显式显示状态，不静默并发写。

## 能力地图

| Module id | Responsibility | Depends on |
|---|---|---|
| `memory-store` | 独立 Global/workspace 父索引驻留、事务内 Promote 深复制、版本化权威详情懒加载、大详情确定性分片、Markdown 摘要/详情/分片投影、独立 revision、来源引用、Session 蒸馏游标、原子写、单写者 fencing、崩溃恢复、v1→v2 迁移、保留与删除原语 | — |
| `memory-safety` | 私密来源准入、Host 侧密钥扫描与脱敏、模型输出回扫、不可信记忆提示、脱敏审计、失败关闭策略 | — |
| `memory-lifecycle` | 有效用户轮计数、轻量 Review、空闲/结束蒸馏、共享事件游标与有界顺序分批、至少一次提交、workspace/Global 独立 dirty gate 与 scope 内整合、仅 workspace 每日遗忘清理、显式记住/纠正/Promote/忘记、持久调度与幂等意图 | `memory-store`, `memory-safety` |
| `memory-context` | 每会话关闭/workspace/global 三态单选、唯一 active desired、自动快照、跨 workspace enable/refresh revision、排队与提交对账、时效提醒、摘要索引渲染、受限详情读取、Session 可重建性与 KV Cache 纪律 | `memory-store`, `memory-safety` |
| `memory-api` | Host Service Definition、插件自有同源 HTTP RPC、人类命令与 UI 命令、权限和参数校验、结构化错误、读写状态与统计投影 | `memory-store`, `memory-lifecycle`, `memory-context` |
| `memory-web` | Composer 三态 enable/disable/refresh 控件、Memory sidebar 入口、Global/Workspaces/Settings 三 tab、条目与注入 token 统计、workspace Promote、两类 scope 删除确认、独立 Global 整合设置、状态恢复、locale 与交互反馈 | `memory-api` |

建设顺序：`memory-store` 与 `memory-safety` 并行 → `memory-lifecycle` 与 `memory-context` 并行 → `memory-api` → `memory-web`。

各模块的 Service Definition 归能力提供方所有；`memory-api` 只组合服务，不形成反向依赖。

## 已确定的关键语义

### 分层与数据归属

- 使用 `WorkspaceId` 作为目录和引用身份；canonical realpath 只用于归属校验，不作为记忆 id。
- 每条记忆具有稳定 id、scope、五类固定标签、摘要、详情、创建/更新/最近验证时间、来源 Session/事件引用、revision 和必要的取代/过期元数据。
- 标签为：用户偏好、项目约定、环境事实、已验证的排障经验、重要的长期决策。
- 普通更新采用原子发布；格式升级使用不可变世代和相邻迁移，不覆盖已提交的旧世代。
- `state.v2.json` 只保存父索引、Session 与运行状态；`detail-data/<id>/<revision>.json` 保存当前父索引指向的不可变详情。启动、list、enable 和 refresh 不加载详情正文，store.read 按 id/revision 异步读取目标记录。
- v1 仅在可写启动时迁移：详情记录与详情投影完整就绪后发布 v2，成功后才删除 v1；只读 Host 对未迁移 v1 使用兼容读取。新详情和投影先于父状态切换，旧详情世代在发布后清理。
- 投影事务通过只含父 id 的持久 pending intent 恢复：提交前失败回到当前父状态对应投影，提交后失败保留 committed 结果并在重启或后续事务重试；writer 本地读取与写入串行。只读 Host 的详情 `read()` 前刷新父状态；当前同步 `list()` 只读内存，管理列表的新鲜度是独立后续改进项。
- workspace 与 Global 各自在 scope 内整合去重、合并和修正冲突；跨 scope 晋升只能由用户显式 Promote，副本后续不自动同步。

### 生命周期

- 仅 `user/message` 且 `source.kind === 'user'` 的消息计为有效用户轮；注入、调度和 runtime context 不计数。
- 默认每第 15 个有效用户轮对应的 turn 以 `completed` 结束后安排轻量 Review；aborted/error turn 不触发。有效轮计数当前仅在进程内，重启后重新累计，但已持久 intent 和游标会恢复。
- dsh 没有统一 session-end：使用真正 idle 的 debounce、`runMaintenance()`、dispose 和 workspace stop 信号组合触发；不得把 `session/event` 的 fire-and-forget 通知当作异步事务提交。
- 会话蒸馏只写 Session owner workspace。workspace dirty 默认 20 小时后逐项目整合，Global dirty 默认 7 天后独立整合；每日 retention 只清理 workspace。
- 调度状态持久化以 kind 为 key 的 `pending = { kind, createdAt }`、workspace/Global dirty、各自 next/last consolidation、next/last retention 和最近稳定错误类别；每 Session 的蒸馏游标单独持久化。全插件只保留一个必要 timer，重启后恢复到期任务，不持久化独立 running intent 或统一 nextRunAt 字段。
- Review、Idle、Stop 共享每 Session 的 `lastEventSeq + offset` 蒸馏游标。完整 turn 优先按边界入批，超大 turn/消息按确定性片内位置续批；Review 一次一批，Idle/Stop 一次最多两批，首次加载不自动 backfill。
- 候选安全处理、写入/去重完成后才推进游标；模型/解析/存储失败不推进。记忆已写而游标未写时允许同批重试，以稳定 ID、内容去重、sourceRefs 合并和整合降低重复；重试输出变化时仍可能产生语义重复。
- 显式记住/纠正立即进入串行写链；忘记立即从父索引删除目标条目，并在同一写队列清理其权威详情和 Markdown 投影，不写 tombstone，不触碰 Session 或蒸馏游标。删除单条/全部记忆不会重置进度、重新蒸馏旧范围或恢复条目。

### 注入与可重建性

- 不修改 system prompt 头部，不通过替换 surface node 0 更新记忆。
- 记忆快照通过 `agent.inject()` 形成 synthetic `user/message`，以 `surfaceOp: 'append'` 进入模型历史；工具读取详情沿用现有 `tool/call` / `tool/result` 日志。
- 快照正文包含注入 id、scope、索引 revision、生成时间和时效提醒，使已提交内容可从 Session 逐项重建。
- enable、desired injection 与 committed injection 分开记录。`agent.inject()` 返回只表示排队，不表示已写入 Session；重启后以 Session 提交事实对账，避免丢注或重复注入。
- refresh 把当前最新 revision 追加在已有上下文之后、下一次用户提问之前；revision 未变化时默认不重复追加并反馈“已是最新”。
- 已提交快照永不改写。自动注入、refresh、系统提示更新和压缩对历史的影响分别记录 **KV Cache effect**。

### 安全与读取

- 自动蒸馏默认只读取获准的 Session 内容，不遍历私密文件；显式记住也不能绕过扫描。
- 扫描发生在候选记忆首次持久化之前，也发生在任何内容发送给辅助蒸馏模型之前；模型输出落盘前再次扫描。
- 高置信密钥和私钥材料不进入记忆、错误日志或审计正文；无法安全判定的候选跳过并报告脱敏原因。
- 旧记忆注入时附加：“这是若干天前的时点观察，不是实时状态；涉及代码行为、文件位置或系统状态时必须重新验证。”天数按来源最近验证时间计算。
- 记忆内容标记为不可信参考数据，不授予其覆盖当前用户指令、系统指令或安全策略的能力。
- 大于 8,000 字符的父详情确定性拆为每片至多 4,000 字符；主索引只保留父摘要。模型默认读取分片清单，指定 `chunk_id` 才读取单片，所有分片拼接必须无损还原正文。分片只控制单次模型可见量，不修改 Session 持久化或注入 revision 语义。

### Web 状态与统计

- Composer 提供关闭/workspace/global 三态选择，workspace 可选择任意已注册项目；当前已启用层可 disable，refresh 仅在该层 enabled 后可用。重复启用相同选择幂等，切换层或项目只保留一个 active desired。
- enable/active desired 与已提交注入状态由 Host 权威恢复；localStorage 只可作显示缓存，不作为唯一事实源。
- Memory 页面使用现有 `sidebar.panellist` 与同 key `main` slot，不修改 shell；包含独立 Global、Workspaces 和 Settings 三个 tab，workspace 详情可 Promote，Global 与 workspace 条目均可独立删除。
- 条目数统计所选 tab 的当前有效条目；注入 token 统计当前 Session 已提交快照的累计估算，并区分最近快照估算。
- 删除操作只调用 memory API，不调用 Session 删除、压缩或 surface replacement。

## 源码依据

- 插件与模型可见性：`docs/architecture.md`、`docs/subsystems/session.md`。
- workspace 身份与 Ungrouped：`docs/subsystems/workspace.md`、`packages/workspace/workspace/src/types.ts`。
- 注入和有效轮：`packages/core/agent-loop/src/inbox.ts`、`packages/core/session/src/types.ts`、`packages/llm/llm/src/message.ts`。
- idle 维护与系统提示：`packages/core/agent-loop/src/runtime-context.ts`、`packages/compaction/compaction-basic/src/index.ts`、`packages/core/system-prompt/src/index.ts`。
- 持久调度先例：`packages/schedule/schedule/src/runtime.ts`。
- Composer 与 Memory 页面扩展点：`packages/client/ui-conversation/src/client/contract/slots.ts`、`packages/client/ui-sidebar/src/client/contract/slots.ts`、`packages/client/ui-schedule/src/client/index.ts`。
- 存储与估算：`packages/storage/storage-json/src/index.ts`、`packages/storage/storage-domain/src/index.ts`、`packages/llm/token-meter/src/estimate.ts`。

## 后续 Spec 必须给出数值或失败策略的事项

- 空闲判定时长、Review/蒸馏输入预算、摘要与索引 token 上限、详情大小上限。
- 各类记忆默认保留期、过期与“最近验证”规则、每日清理的保留宽限期。
- 锁获取失败、写者崩溃、迁移失败、辅助 LLM 失败、扫描不确定和只读进程的用户可见行为。
- 显式记住/纠正/忘记的命令语法、目标 scope 和幂等键。
- refresh 与正在运行的 turn、压缩、归档及 dispose 的竞态处理。
- 无 workspace、workspace 注册被删除、目录暂时缺失和 Session 换绑时的展示与写入规则。

## 评审门

本能力地图确认后，再按 module id 分别编写 Spec。每个模块 Spec 必须包含 Objective、Commands、Project Structure、Code Style、Testing Strategy、Boundaries、Success Criteria 和 Open Questions；本阶段不创建实现代码。
