# Spec: memory-lifecycle

> 2026-10-29 活动日志修订：新增独立、非权威的 `logs/lifecycle.v1.jsonl`，按持久 intent ID 追踪任务建立、执行、批次、成功、跳过、失败和重试；日志采用字段白名单、大小轮转与 best-effort 写入，不改变记忆状态或 Session。
>
> 2026-10-29 rank 反馈修订：`snail_memory_feedback` 与读取工具结果均从后续蒸馏转录中排除；rank-only 更新不触发 dirty、整合、保留期、revision、游标或新快照变化。
>
> 2026-10-28 数据与调度修订：整合来源由程序按输入快照汇集，模型 `id/supersedes` 仅可引用本次输入条目，完整候选回扫；生命周期 pending intent 增加持久 ID，旧任务不得清理或改写新代 intent。
>
> 2026-10-28 独立 Global 修订：Review/Idle/Stop 和 retention 仍只处理 workspace；Global 由人工 Promote 建立，使用独立 `globalDirty`、默认 7 天 consolidation 和独立持久 intent，不继承 workspace 的 20 小时计时。
>
> 2026-10-27 长历史覆盖修订：Review/Idle/Stop 共享按 Session 持久化的事件游标，顺序处理后续批次，不再重复截取转录开头。

## Objective

实现显式记忆操作和自动记忆生命周期：每 15 个有效用户轮轻量 Review、60 分钟空闲或结束蒸馏、workspace dirty 默认 20 小时后 scope 内整合、独立 Global dirty 默认 7 天后整合、每 24 小时 workspace 遗忘清理。

## Tech Stack

TypeScript、Cordis Host events、`agent.runMaintenance()`、`ctx.llm.prepareCall()`、持久任务状态、Vitest fake timers。

## Commands

```sh
npm run test -- tests/lifecycle
npm run typecheck
npm run build
npm run lint
```

## Project Structure

```text
src/lifecycle/counters.ts   → 有效用户轮与 completed turn 关联
src/lifecycle/scheduler.ts  → nextRunAt、dirty、单 timer、重启恢复与活动状态流转
src/lifecycle/activity.ts   → 白名单活动记录、结构化运行结果、JSONL 轮转与 flush/close
src/lifecycle/settings.ts   → UI 设置校验、原子持久化与只读边界
src/lifecycle/llm.ts        → 一次性辅助模型调用与 JSON 解析
src/lifecycle/distill.ts    → 会话候选蒸馏、至少一次提交与游标推进
src/lifecycle/consolidate.ts→ 去重、合并、冲突修正、摘要更新
src/lifecycle/retention.ts  → 分类保留与每日清理
src/lifecycle/service.ts    → remember/correct/forget 与事件装配
tests/lifecycle/            → 事件、调度、预算和失败测试
```

## Configuration Defaults

- `reviewEveryUserTurns = 15`；仅真实 `source.kind === 'user'`，且所在 turn `completed` 后触发。有效轮计数、pending/completed turn 关联和事件去重当前只保存在进程内，重启后重新累计；已持久化的生命周期 intent 和蒸馏游标不受此重置影响。
- `idleDelayMinutes = 60`；新活动刷新同 Session idle intent 的创建时间并重排唯一 timer，形成 debounce；dispose 不再启动新 maintenance，但会 drain 已进入队列的工作。
- `consolidationCooldownHours = 20`；workspace dirty 为必要条件，成功或失败后记录持久结果，重启不错过到期任务。
- `globalConsolidationCooldownDays = 7`；独立 Global dirty、intent、成功、失败与重试不清理或重排 workspace 状态。
- Settings 页可调整上述四项、`snapshotTokenBudget` 和五类 `retentionDays`；`settings.v1.json` 原子持久化并优先于启动默认值，旧文件缺少新增字段时补用对应默认值。保存后保留当前进程内轮计数，分别重排已有 idle intent、workspace 与 Global dirty/consolidation 计划，只读 Host 拒绝更新。
- Workspaces 页从完整 WorkspaceRegistry 选择任意已注册 workspace 并读取其索引，不以当前 Session 或已有记忆引用为限。
- `retentionSweepHours = 24`。
- 首次加载只恢复已有记忆、调度和注入状态，不自动遍历并蒸馏全部历史 Session；历史回填不是默认生命周期任务。
- 默认保留期：环境事实 30 天、项目约定/排障经验 180 天、用户偏好/长期决策 0 天（不自动过期）；五类均可配置，修改从下一次每日清理生效，显式 `expiresAt` 始终优先。过期结论先从最近验证时间判定。
- Review 每批输入最多 24,000 字符且每次 intent 只处理一批；Idle/Stop 每批最多 48,000 字符，每次 intent 最多连续追赶两批。整合最多 64,000 字符；详情单条最多 16,000 字符。长历史通过后续生命周期 intent 继续推进，不做无预算全量回填。
- Review/Idle/Stop 共享 `SessionMemoryState.distillationCursor`。游标以最后处理的稳定 `eventSeq` 为主身份，以该事件渲染文本内已消费的 UTF-16 `offset` 处理超大消息；完整 turn 能装入预算时不得拆分，超大 turn 再按事件顺序和片内 offset 分片。
- 只有模型响应可解析、候选完成安全校验且写入/去重成功，或候选为空/被安全策略完整拒绝后，才通过主 MemoryStore 串行 writer 推进游标。路由缺失、请求失败/取消/超时、不可解析输出、输入拒绝或存储失败均保留原游标。
- 记忆提交后、游标提交前崩溃允许重试同批；稳定 ID、内容去重、sourceRefs 合并和后续整合承担至少一次语义。不得先推进游标再调用模型或写记忆。
- Review/蒸馏的转录投影仅保留真实用户消息、助手消息和普通工具结果；通过 `tool/call.callId` 排除 `snail_memory_read` 与 `snail_memory_feedback` 的 `tool/result`，不按结果正文过滤，也不修改原始 Session。记忆详情和反馈回执因此不会成为下一批蒸馏证据，普通工具结果仍保留。
- rank-only 反馈不是内容写入：不设置 workspace/Global dirty，不安排或重排 consolidation/retention，不推进条目或 scope revision，不修改 `updatedAt`、`lastVerifiedAt`、蒸馏游标，也不生成 desired/committed 新快照。
- 注入索引默认上限 1,200 估算 token，可在 Settings 调整 `snapshotTokenBudget`；新值仅用于后续 Enable/Refresh 新快照，不改写历史快照。条目按 `updatedAt` 从新到旧逐条加入，下一条会使估算超预算时停止并报告剩余数量；rank 不参与该顺序，也没有独立的 800 token 核心摘要预算或“高置信”排序，固定头部和尾部说明也不计入该条目循环的硬上限。

## Lifecycle Activity

- 活动历史写入 `$DSH_HOME/snail_memory/logs/lifecycle.v1.jsonl`，不进入权威状态，不与事务 audit 混用，也不修改 dsh Session。首版通过文件直接排查，不新增 UI 或 RPC。
- 六类 operation 为 `review`、`idle`、`stop`、`consolidate`、`global-consolidate`、`retention`；七类 event 为 `intent-created`、`run-started`、`batch-completed`、`run-succeeded`、`run-skipped`、`run-failed`、`retry-scheduled`。同一 intent ID 串联一次运行，retry-scheduled 另记录 retryIntentId 和真实 retryAt。
- 白名单字段为 formatVersion/time/event/operation/intentId、可选 sessionId/workspaceId、durationMs、batch/batches、written/rejected、processed/hasMore、仅含 lastEventSeq/offset 的 cursor、skipReason、稳定 error 和重试元数据。不得记录对话、prompt、summary/detail、sourceRefs、模型原始响应、异常正文或秘密。
- intent-created 只在 intent 成功持久建立后记录；已有 idle intent 的 debounce 刷新保留同代 intent ID，只更新 createdAt，不重复记录，确保建立与后续运行事件可串联；deferred intent 在 start 成功提交后记录。自动到期的 consolidation/retention 先持久 pending 再记录。
- run-succeeded 和业务型 run-skipped 在业务运行及权威调度状态收尾成功后记录；无 owner、无新事件、clean workspace 分别使用 `workspace-unassigned`、`no-new-events`、`workspace-clean`。clean workspace 不调用 run，也不记录 run-started。
- 每个实际蒸馏批次记录 batch-completed、written/rejected 和游标位置。失败只记录 `model-route-missing`、`model-request-failed`、`model-output-invalid`、`store-readonly`、`operation-aborted`、`operation-failed`；只有实际创建新代 retry intent 才记录 retry-scheduled。
- `MemoryLifecycleService.runIntentDetailed()` 提供结构化运行与逐批结果，既有 `runIntent() → { written }` 保持兼容。非蒸馏任务 batches 为 0，retention 的 written 为删除数，consolidation 的 written 为写入数。
- 文件 sink 以独立 Promise 队列串行 append，默认单文件上限 1 MiB，保留当前文件加最多 `.1`、`.2`、`.3` 三个历史代际。写入与告警 best-effort，日志失败不得改变业务结果；Scheduler dispose 先 flush，插件卸载再 close。

## Code Style

```ts
if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
const pending = this.pendingTurns.get(sessionId)
pending?.count += 1
```

任务以 kind 为 pending key、以持久 `{ id, kind, createdAt }` 为运行代际串行执行。每次新 intent、失败重试和 consolidation 设置重排都生成新 ID；旧任务仅能在当前 pending ID 仍等于运行快照时清理或改写它。Review/Stop 失败转为 Idle 时必须保留目标 key 上已有的新 Idle。该 ID 是调度代际，不是候选业务幂等键；至少一次处理仍通过稳定记忆 ID、内容比较和 sourceRefs 合并去重。post-commit 事件只负责观察，不承担写事务。LLM 失败保留可重试状态，不伪造成功。

## Concurrency Boundaries

- 整合候选关联模型调用前的条目快照，写前重新读取并核对条目 revision；模型等待期间已删除或已纠正的条目不得接受旧候选。
- 模型返回的 `sourceRefs` 不进入解析后的候选。候选 `id` 和 `supersedes` 只能引用经 64,000 字符预算截断后、实际发送给模型的输入快照中的真实条目；未知、被预算排除、跨快照或指向目标自身的 supersedes 不生效。最终来源由程序从现有目标与有效 supersedes 条目的真实 `sourceRefs` 汇集并按 JSON 精确值去重。
- 完整候选在结构校验后回扫：同时扫描原始 JSON 与递归收集的所有字符串键/值，覆盖 summary/detail、id/supersedes、sourceRefs 和未消费额外字段；任何 finding 都拒绝该候选，模型提供的元数据不能绕开安全扫描。
- 整合成功以及 Scheduler 的 consolidation 成功/失败收尾会核对调用前的 next consolidation 时间；运行期间新 Promote/Delete 或设置热更新建立的 dirty 与重排计划不得被旧任务清除或覆盖。
- 上述防护尚未形成完整条件写事务：`store.read()` 与 `store.upsert()` 之间仍存在小的删除/纠正交错窗口，`supersedes` 的 `read()` → `remove()` 也没有核对旧条目 revision，可能删除模型等待期间新纠正的版本。expected-revision 原子条件写/条件删除记入后续 Plan，不能宣称该竞态已完全关闭。
- Scheduler 的 pending key 仍是 kind，但每个值有独立持久 ID。成功清理、失败重试、deferred 快照提交和设置热重排均按 ID 保护新代记录；旧任务运行期间到达的同 key 新 intent 必须保留。旧持久记录缺少 ID 时，读取阶段按 key 和 createdAt 补稳定兼容 ID。

## Testing Strategy

- 注入、schedule、runtime-context 不计有效轮；aborted/error 不触发 Review。
- 第 14/15/16 轮边界、当前进程内计数重置行为、持久 intent/游标的重启恢复、重复事件和乱序通知。
- idle debounce、非 idle maintenance 竞态、dispose、archive/stop。
- 20 小时默认冷却、dirty 设置热更新与计划重排、dirty gate、每日清理、单 timer 和卸载 drain。
- 五类保留期默认值、持久化与 RPC 校验；`0` 天关闭类别过期，自定义策略在下一次清理生效，显式过期时间优先。
- 快照预算默认值、旧配置兼容、RPC/UI 保存，以及预算变更只影响后续新快照。
- LLM 空输出、非 JSON、部分有效候选、秘密输出、超时和重试。
- `snail_memory_read` 与 `snail_memory_feedback` 结果不进入蒸馏输入，普通工具结果继续保留。
- rank 反馈前后 dirty、pending、consolidation/retention 计划、条目与 scope revision、内容时间、游标及注入状态保持不变；反馈不触发辅助模型调用。
- 顺序批次、三入口不重复、空候选/安全拒绝仍推进、路由/请求/解析/存储失败不推进、重启恢复和写入后游标未推进的重复窗口。
- 完整 turn 边界、超大 turn/消息片内恢复、长会话中段和尾部覆盖、Session/workspace 隔离；游标-only 提交不推进 scope revision、不设置 dirty、不生成注入快照。
- 删除单条和全部记忆后所有 Session 游标保持不变，后续入口不重新蒸馏已处理范围，也不恢复已删条目。
- 验证整合不跨 scope 自动晋升，不修改 Session。
- Global 默认 7 天冷却、独立 dirty/intent/成功/失败/重试和热更新，以及与 workspace 20 小时计划的隔离。
- 慢模型期间删除或纠正后旧候选不写回；旧整合及 Scheduler 任务不清除运行期间新 Promote/Delete 建立的 Global dirty 和重排计划。
- 模型伪造 sourceRefs 不落盘，sourceRefs/supersedes 元数据中的秘密导致完整候选拒绝；合并结果只汇集实际模型输入内目标与被取代条目的真实来源，快照外及被 64,000 字符预算截断的 id/supersedes 不写回、不删除条目、不贡献来源。
- 旧 Review 成功时保留同 key 新 Review，旧 Review 失败时不覆盖新 Idle；重试、deferred 提交、热重排和旧 pending 无 ID 数据均保持代际与兼容语义。
- 验证同一 intent 的 created/started/batch/succeeded 使用相同 ID，逐批 written/rejected/cursor、运行耗时和最终计数准确；两次 idle debounce 只产生一条 intent-created。
- 验证 clean workspace、无 owner 和无新事件的 skipReason；失败只记录稳定分类，retry-scheduled 关联真实新 ID/到期时间且不包含异常正文。
- 验证活动 sink 同步抛错、文件写入失败和告警回调失败均不改变 pending 清理、lastError 或记忆任务结果；JSONL 白名单、1 MiB/代际可配轮转、close drain 和 Host 卸载 close 均有回归。

## Boundaries

- Always：先安全扫描；持久 intent 和事件游标；串行写；保留可重试失败；批处理成功后推进游标；活动日志字段白名单和 best-effort。
- Ask first：改变频率默认值、增加自动 scope 晋升或新模型路由、启用显式历史 backfill；把活动历史变成权威状态或新增外部日志服务。
- Never：用 jobs-local 代替持久恢复；在 post-commit 回调里阻塞 Session；删除对话历史；用删除记忆按钮重置游标或恢复历史蒸馏；让日志写失败改判业务失败。

## Success Criteria

- 所有触发频率和边界符合默认值。
- 自动蒸馏只写入当前已验证 workspace；Ungrouped 不自动写全局。
- 整合在 scope 内去重、合并、修正冲突、删除过期结论并更新摘要/索引。
- 显式 remember/correct/forget 无需等待 Review，立即持久化并广播变化。
- 崩溃重启后已持久任务和游标不丢，游标从下一未处理位置继续；记忆已写而游标未提交时允许同批重放，相同候选依靠稳定 ID、内容比较和 sourceRefs 合并去重，但重试输出变化时仍可能出现语义重复，不承诺绝不重复调用模型或生成近义条目。
- Review/Idle/Stop 最终可覆盖持续变长 Session 的中段和尾部，同时保持每次维护调用的批次与字符预算有界。
- 记忆读取与反馈结果不进入后续蒸馏，rank-only 更新不触发任何生命周期内容维护或快照。
- 可按 intent ID 从活动 JSONL 还原每次任务的建立、实际批次、成功/跳过/失败与重试链；日志不包含正文或异常原文，轮转、写入失败和卸载不影响权威记忆与调度状态。

## Open Questions

无阻塞项。首版 Review/蒸馏使用当前可用模型路由；无可用路由时显式报告并保留 dirty，不创建虚假记忆。
