# Spec: memory-store

> 2026-10-29 活动日志修订：生命周期运行历史使用独立 `logs/lifecycle.v1.jsonl`，不进入 `state.v2.json`，也不与事务 `audit.v1.jsonl` 混用；活动日志不是权威状态，写失败不得改变已提交的记忆或调度结果。
>
> 2026-10-29 rank 反馈修订：父条目增加默认 0 的 `rank`；committed 快照保存实际渲染的 memory ID 和逐条目反馈回执，Store 以同一原子事务完成资格校验、rank 更新与幂等回执，且 rank-only 更新不触碰内容或生命周期状态。
>
> 2026-10-28 运行范围修订：当前定案为单一 dsh Client、单 Host。既有写锁、只读与接管逻辑保留为意外重复启动防护，但不据此宣称支持多 Host 共同写入；完整跨 Host 事务 fencing 暂缓。
>
> 2026-10-28 独立 Global 修订：Global 从动态只读聚合改为独立权威 scope。workspace 详情可 Promote 深复制到 Global，副本以新 ID、独立详情和 `promotedFrom` 维护；重复 Promote 幂等，来源与副本更新/删除互不影响。以 `SPEC-global-aggregate-memory.md` 的当前独立 Global 契约为准。
>
> 2026-10-28 修订：修复快速重启留下的新鲜旧锁使新 Host 永久只读的问题。只读 Host 必须持续重试，在锁释放或 stale 后完成状态恢复并自动晋升；活跃 writer 仍受单写者保护。
>
> 2026-10-28 跨 workspace 修订：Session 写入 owner 与召回选择分离，workspace desired/committed 可记录来源项目以独立对账 revision；旧记录保持可选兼容。

## Objective

为 Snail Memory 提供单用户、全局/workspace 分层的持久存储。存储是所有读写、索引展示、注入 revision 和删除语义的权威来源；原始 Session 永远不由本模块修改。

验收结果：重启后记忆与会话开关状态可恢复；Global 只包含独立条目；Promote 完整复制且幂等，来源与副本互不影响；忘记后目标条目正文和索引不再可读；异常写入不会暴露半条 JSON 或半条 Markdown。

## Tech Stack

TypeScript、Node.js 22 `node:fs/promises`、父索引 JSON 快照、版本化详情 JSON、JSONL 无正文审计事件、Markdown 可读投影、Vitest。运行数据全部位于 `resolveDshHome(configuredHome)/snail_memory`。

## Commands

```sh
npm install
npm run test -- tests/store
npm run typecheck
npm run build
npm run lint
```

## Project Structure

```text
src/store/types.ts       → MemoryEntry、Scope、Index、SessionMemoryState、Config 类型
src/store/paths.ts       → 根目录和 workspace 目录解析
src/store/lock.ts        → 进程锁、heartbeat、writer fencing
src/store/json.ts        → 原子 JSON 写入、v1/v2 恢复和校验
src/store/records.ts     → 版本化权威详情的按需读取与孤儿清理
src/store/chunks.ts      → 大详情确定性分片与完整正文还原
src/store/projections.ts → INDEX.md、MEMORY.md、详情与分片 Markdown
src/store/store.ts       → 串行读写、revision、审计与删除
tests/store/             → Temp 目录单元和崩溃恢复测试
```

## Data Contract

- `MemoryScope` 为 `{ kind: 'global' }` 或 `{ kind: 'workspace', workspaceId }`；目录只使用 branded id 的字符串值。
- `MemoryEntry` 包含 `id`、`scope`、`category`、`summary`、`detail`、`createdAt`、`updatedAt`、`lastVerifiedAt`、`revision`、`sourceRefs`、整数 `rank`，以及可选 `expiresAt`、`supersedes`、`promotedFrom`。新条目和 Promote 新 Global 副本的 rank 为 0；已有 ID 的内容纠正和 consolidation 沿用目标 rank，不相加被取代条目的 rank。旧 v2 状态缺少 rank 或 rank 不是安全整数时恢复为 0，不升级格式版本。
- rank 是条目级使用反馈，不是内容 revision、正确性或可信度。它保存在父索引中，列表和详情无需读取权威详情即可展示。
- 五类 category 为 `preference`、`project-convention`、`environment-fact`、`troubleshooting`、`long-term-decision`。
- `state.v2.json` 原子发布父索引、Session 和运行状态；父条目只保存摘要等元数据及 `detailChars`，不保存完整 `detail`。Host 启动只把这份父状态加载进内存，`list()`、`enable()` 和 `refresh()` 不读取详情记录。
- `detail-data/<id>/<revision>.json` 保存父状态指向的不可变权威详情。`read()` 按 id 和 revision 异步读取目标记录并重新组成完整 `MemoryEntry`；不得为读取一个条目而加载全部详情。
- 首次可写启动发现仅有 `state.v1.json` 时，先写出所有版本化详情及详情投影，再原子发布 v2，成功后才删除 v1。v1 尚未迁移且 Host 为只读时保留旧兼容读取路径；可写实例完成迁移后不再保留正文副本。
- 写入或纠正先完整写入新详情记录和详情 Markdown 投影，再切换父状态；父状态发布后清理旧 revision 和孤儿记录。删除在同事务队列中移除父索引、权威详情和投影，不修改 Session。
- 每次事务在改动投影前持久化 `projection-pending.v1.json`，其中只含受影响父 id，不含正文。提交前失败按当前父状态尝试恢复原详情投影，恢复本身失败时同样保留 intent；进程崩溃或提交后派生失败保留该 intent，由下次可写启动或后续事务重建详情、INDEX/MEMORY 并清理未引用记录。权威父状态已提交后，派生失败不得向调用方误报为未提交。
- Markdown 是可重建投影，不是第二份权威数据。正常启动只重建 INDEX/MEMORY 索引投影，不为了重建所有详情投影而 eager-read 全部权威详情；详情投影在迁移、对应条目写入或 pending 恢复时更新。
- 小详情、INDEX 和 MEMORY 使用临时文件原子替换；大详情继续使用临时目录整套切换。writer 的详情读取与写入进入同一串行队列；只读 Host 的详情 `read()` 前刷新 v2 父状态，详情记录 ENOENT 时再刷新并重试，以观察其他 Host 已提交的纠正和删除。当前同步 `list()` 和 `workspaceScopes()` 只读取本进程内存，不主动刷新；第二 Host 的列表可能保持陈旧，直到详情读取、writer 晋升或重启，后续应为管理 RPC 提供异步 fresh-list 路径。
- WriterLock 在持有锁时通过本代 FileHandle 续心跳，在未持有锁时按同一周期间隔重试。stale 回收必须核对 quarantine 中移出的原始锁内容，误移新锁时用硬链接恢复；锁缺失时恢复崩溃遗留的 quarantine，主锁仍存在时则把遗留 quarantine 作为过期残留清理，不得反复移走当前主锁。启动时仍新鲜、随后才 stale 的旧锁与启动时已 stale 的锁都必须可恢复；锁被正常释放后同样允许接管。晋升与 heartbeat 解耦，晋升前重新读取最新 v2（或兼容迁移 v1）、恢复 pending 投影，并在各共享写入阶段续租验权，完成后才发布 writable；活跃 writer 心跳有效时不得抢锁。Store 事务边界把可识别的所有权/fencing 异常统一转换为 `MemoryStoreReadonlyError`，普通 I/O 和编程错误仍按原类别抛出。writable 变化通知 Host 启停 lifecycle，首次及后续准备或启动失败都在当前可写期间自动重试；暂停、只读或验权竞争期间收到的新 intent 在可写启动后补持久化。`start()` 必须提交 deferred 快照，并且只清理该快照中已经持久化且当前值未变化的条目；提交期间新增或更新的 intent 必须保留到后续启动。卸载停止监控、重试并清理 timer。
- 当前实现尚未把上述锁协议闭合为完整事务 fencing：Store transaction 只在开始时 `assertWritable()`，进行中的事务在锁所有权变化后仍可能发布旧 draft，覆盖继任 writer 已提交的父状态。后续需要 writer 代际和原子条件发布，并补进行中事务与 stale takeover 的交错测试；在此之前不能宣称旧 fencing token 在所有阶段都绝对不能提交。
- `audit.v1.jsonl` 只记录操作、id、revision、时间和脱敏结果，不记录记忆正文、秘密或完整提示词。
- `logs/lifecycle.v1.jsonl` 是生命周期活动历史，不是 Store 权威状态或事务审计。它按 intent ID 记录任务建立、执行、批次、成功、跳过、失败和重试元数据，默认 1 MiB 轮转并保留三个历史代际；activity 与 audit 各自使用独立序列写队列，activity 失败只产生脱敏告警，绝不回滚或改判已提交的记忆/调度状态。
- `global/INDEX.md` 只包含独立 Global 条目，不包含 workspace 聚合引用；Promote 通过新 ID、独立版本化详情和 `promotedFrom` 深复制，不共享来源详情或分片所有权。
- 每会话独立保存两个层的 `enabled`、`desired`、已提交 injection id/revision 和估算 token，以及唯一 `activeDesired` 和可选 `distillationCursor = { lastEventSeq, offset, updatedAt }`。游标只保存事件位置和提交时间，不保存转录正文、秘密或异常原文。
- 新 desired/committed injection 保存 `memoryIds`，即该快照在 token 预算内实际渲染的父条目 ID，而不是完整索引或仅被读取的条目；旧记录可缺省，缺省时不授予反馈资格。committed injection 另保存 `feedback[memoryId] = outcome` 回执，使同一 Session + injectionId + memoryId 在重启后仍只能接受一次反馈；新 committed injection 可形成新的反馈机会。
- `recordFeedback()` 必须在 Store 同一串行 transaction 内完成：按当前 Session 和启用 layer 推导 scope，从最新 committed 向前找到实际包含目标 memoryId 且召回 workspace 匹配的记录，检查回执，再同时更新父条目 rank 与该 committed 回执。`helpful` 为 +1，`unhelpful` 和 `incorrect` 为 -1；模型不能传 delta、reason、injectionId 或 workspace。
- 未启用、目标未实际渲染进 committed 快照、条目不属于当前 scope 或已删除时分别拒绝；重复反馈返回 duplicate 且不再次改分。被 token 预算省略、仅出现在 desired/queued 或仅被 `snail_memory_read` 读取的条目均没有资格。
- rank-only 事务不得修改 summary/detail/sourceRefs 等内容字段、条目内容 revision、scope revision、`updatedAt`、`lastVerifiedAt`、workspace/Global dirty、consolidation 调度、Session 蒸馏游标或注入快照；不得通过 `read() → upsert()` 实现。Store 总状态事务可正常前进，但不因此产生新详情世代或新快照。
- Session `workspaceId` 是自动蒸馏与显式写入的 owner；可选 `selectedWorkspaceId` 是独立的 workspace 召回选择，只用于快照、refresh 和详情读取。enable 其他已注册项目不得改写 owner，Ungrouped 也不会因召回选择获得隐式写入归属。
- workspace desired/committed 可保存 `workspaceId`，用于按召回项目分别进行 revision 对账、反馈资格和公共状态展示；global 及旧版 workspace 记录可缺省该字段，按兼容路径处理。不同 workspace 的 revision 不得跨项目取最大值。
- 游标更新复用 `updateSessionState` 和主串行 transaction，因此同样经过 writer queue、`lock.assertOwner()`、原子状态发布和故障恢复。游标-only 更新不推进 scope revision、不设置 dirty、不创建 desired injection 或快照。
- 生命周期 `meta.pending` 以 kind 为 key，值为 `LifecycleIntent = { id, kind, createdAt }`。ID 标识调度代际，供 Scheduler 条件收尾；旧 v2 状态缺少 ID 时，读取阶段补 `legacy:<key>:<createdAt>` 稳定兼容 ID，不要求用户手工迁移或删除状态。
- MemoryEntry 删除与 Session 蒸馏游标是正交事实。单条/全部删除不得修改、重置或推进游标，不得使旧范围重新蒸馏，也不得恢复已删条目；只有宿主真实 Session 生命周期清理才可另议游标垃圾回收。
- 普通更新不改 Session；格式迁移创建新 successor。显式隐私删除允许清理本插件旧数据世代，但不允许删除 Session 世代。

### 大详情分片

- 父状态指向的 `detail-data/<id>/<revision>.json` 是唯一当前权威正文；`detailChars` 只用于索引链接和记录完整性校验。大详情分片仍是确定性派生数据，不作为权威正文，也不进入启动时的父状态。
- 详情长度大于 8,000 UTF-16 code unit 时启用分片；每片不超过 4,000 code unit。等于 8,000 的详情保持未分片。这里的阈值是磁盘/工具切分边界，不等同于 token 上限。
- 分片优先在段落、换行、空白边界结束，无法找到合适边界时在硬上限处拆分；不得为了边界丢弃或改写字符。所有分片正文按顺序拼接必须严格满足 `chunks.map(chunk => chunk.text).join('') === detail`。
- 分片 id 为父条目内确定性的 `part-001`、`part-002` 等；模型调用必须同时提供父 `memory_id` 和 `chunk_id`，分片 id 不作为主索引中的独立记忆。
- 未分片详情继续投影为 `details/<id>.md`；分片详情投影为 `details/<id>/INDEX.md` 和 `details/<id>/part-NNN.md`。分片 INDEX 只含父摘要和分片元数据，不复制完整正文。
- scope 的 `INDEX.md` 与 `MEMORY.md` 仍只列父记忆摘要，每个父条目只占一项；分片条目的 INDEX 链接进入其分片目录，不按分片数膨胀主索引。
- 分片目录先在同级临时目录完整写入，再切换为目标目录；切换失败必须恢复旧目录，崩溃残留的临时/备份目录在下一次投影时恢复或清理。不得在旧目录内逐片覆盖并暴露半套新正文。
- 每次投影发布都清理目标条目的另一种形态及多余旧分片；纠正导致分片数量变化或形态切换后不得残留可读旧正文。删除父记忆同时删除旧式详情文件和整个对应分片目录，清理与后续同事务队列写入串行，但不修改 Session desired/committed 或 dsh 对话历史。

## Code Style

```ts
export interface MemoryEntry {
  readonly id: MemoryId
  readonly scope: MemoryScope
  readonly category: MemoryCategory
  readonly summary: string
  readonly detail: string
  readonly revision: number
  readonly lastVerifiedAt: string
}

async write(entry: MemoryEntry): Promise<void> {
  await this.queue.run(() => this.writeCommitted(entry))
}
```

严格 TypeScript；跨文件、JSON、RPC 边界校验，内部已类型化值不重复做防御性 any/unknown cast。所有写操作经同一串行队列；父状态原子发布成功后立即同步内存，派生索引投影失败不得让内存回退到已不存在的旧权威状态。

## Testing Strategy

- 临时目录测试全局/workspace 隔离、索引引用、revision 和重启恢复。
- 测试忘记只删除目标条目，不影响其他条目、Session、注入历史或蒸馏游标；删除全部条目同样不触发旧范围重蒸馏。
- 验证游标重启恢复、writer/只读边界，以及游标-only 更新不改变 scope revision、dirty 和 desired injections。
- 验证召回选择不改变 Session 写入 owner，workspace A→B 移动唯一 active；desired/committed 按项目对账，旧版缺省 workspaceId 的记录保持兼容。
- 模拟锁占用、stale lock、写失败、损坏 JSON、截断审计尾和崩溃残留 tmp。
- 验证同 root 第二写者初始只读，旧 fencing token 不能提交；覆盖快速重启时旧锁先新鲜后 stale 的自动晋升、锁正常释放后的状态重载、活跃 heartbeat 不被抢占、失去所有权通知和 lifecycle 暂停/恢复。
- 确定性交错两个 Host 的 stale 回收，验证误移新锁会恢复且只有一个获取者；覆盖 quarantine 崩溃恢复、主锁与遗留 quarantine 并存时清理残留且不活锁、旧 FileHandle heartbeat 不覆盖继任锁、晋升期间持续 heartbeat、首次及后续 Host 准备/启动失败重试、暂停/只读/fencing 验权竞争期间的 intent 补持久化，以及启动提交 deferred 快照期间新增 intent 不被清理。
- 验证 Markdown 注入转义、Unicode、CRLF/LF 与确定性输出。
- 验证 8,000/8,001 阈值、4,000 硬上限、语义边界与无空白长正文、分片拼接逐字符还原。
- 验证分片目录投影、父索引单项链接、纠正缩片/取消分片及删除后的陈旧文件清理。
- 用文件读取观测证明启动和 `list()` 不读取详情记录，第一次 `read()` 只读取目标 id/revision；v2 父状态不含正文。
- 验证 v1 迁移内容无损、迁移失败保留 v1、只读 Host 可兼容读取未迁移 v1，详情记录或投影写失败不推进父 revision，纠正后旧版本及删除后的权威详情被清理。
- 注入父状态、详情记录、分片和索引写失败，验证提交前恢复旧投影、提交后返回 committed 结果、pending 在重开后恢复，以及本地 read/remove 串行和第二 Host 纠正/删除可见性。
- 验证保留期清理只消费父索引，不读取 `detail-data`。
- 验证旧 pending 记录恢复后获得稳定 intent ID，后续 Scheduler 可按 ID 区分新旧代际。
- 验证新条目默认 rank 0、非法旧 rank 恢复 0、内容纠正保留 rank、Promote 副本 rank 0；三种 outcome 分别产生 +1/-1。
- 验证反馈只接受当前 committed 快照实际渲染的 ID；desired/queued、预算省略、旧无 memoryIds、已删除或错误 scope 均拒绝。相同 Session + injection + memory 在重启前后幂等，新 committed injection 可再次反馈。
- 验证 rank 与回执原子提交，且内容字段、条目/scope revision、内容时间、dirty、consolidation、游标和注入快照均不变化。

## Boundaries

- Always：所有数据留在 snail_memory；原子写；单写者；删除只作用于本插件数据。
- Ask first：改变持久格式、引入数据库、扩大可读取目录。
- Never：修改 dsh 源码或 Session；把正文/秘密写进审计或活动日志；把活动日志当成权威状态；用 workspace path 代替 WorkspaceId。

## Success Criteria

- 所有 CRUD 和会话状态在重启后一致；快速重启遇到尚未 stale 的旧锁时无需二次重启，锁过期或释放后可自动恢复写入和 lifecycle。
- 全局与 workspace 索引不串层；Ungrouped 的召回选择不会生成新 workspace 目录或隐式写入 owner。
- 任意写失败不破坏最后一个已提交状态。
- 忘记后 list/read 均不可取得条目，详情文件和分片目录被移除，审计无正文。
- 大详情主索引不随分片数增长，投影与工具均可确定性重建，旧分片不残留。
- rank 反馈只对已提交且实际渲染的条目生效，跨重启幂等；rank-only 更新不引发内容、revision、生命周期、游标或快照副作用。
- 测试、typecheck、build 通过。

## Open Questions

无阻塞项。当前采用父索引快照与版本化详情记录，不引入数据库；只有实测规模证明需要索引数据库或详情缓存时才另提 Spec 变更。
