# Spec: memory-store

## Objective

为 Snail Memory 提供单用户、全局/workspace 分层的持久存储。存储是所有读写、索引展示、注入 revision 和删除语义的权威来源；原始 Session 永远不由本模块修改。

验收结果：重启后记忆与会话开关状态可恢复；全局索引包含 workspace 引用；忘记后条目正文和索引不再可读；异常写入不会暴露半条 JSON 或半条 Markdown。

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
- `MemoryEntry` 包含 `id`、`scope`、`category`、`summary`、`detail`、`createdAt`、`updatedAt`、`lastVerifiedAt`、`revision`、`sourceRefs`，以及可选 `expiresAt`、`supersedes`。
- 五类 category 为 `preference`、`project-convention`、`environment-fact`、`troubleshooting`、`long-term-decision`。
- `state.v2.json` 原子发布父索引、Session 和运行状态；父条目只保存摘要等元数据及 `detailChars`，不保存完整 `detail`。Host 启动只把这份父状态加载进内存，`list()`、`enable()` 和 `refresh()` 不读取详情记录。
- `detail-data/<id>/<revision>.json` 保存父状态指向的不可变权威详情。`read()` 按 id 和 revision 异步读取目标记录并重新组成完整 `MemoryEntry`；不得为读取一个条目而加载全部详情。
- 首次可写启动发现仅有 `state.v1.json` 时，先写出所有版本化详情及详情投影，再原子发布 v2，成功后才删除 v1。v1 尚未迁移且 Host 为只读时保留旧兼容读取路径；可写实例完成迁移后不再保留正文副本。
- 写入或纠正先完整写入新详情记录和详情 Markdown 投影，再切换父状态；父状态发布后清理旧 revision 和孤儿记录。删除在同事务队列中移除父索引、权威详情和投影，不修改 Session。
- 每次事务在改动投影前持久化 `projection-pending.v1.json`，其中只含受影响父 id，不含正文。提交前失败按当前父状态尝试恢复原详情投影，恢复本身失败时同样保留 intent；进程崩溃或提交后派生失败保留该 intent，由下次可写启动或后续事务重建详情、INDEX/MEMORY 并清理未引用记录。权威父状态已提交后，派生失败不得向调用方误报为未提交。
- Markdown 是可重建投影，不是第二份权威数据。正常启动只重建 INDEX/MEMORY 索引投影，不为了重建所有详情投影而 eager-read 全部权威详情；详情投影在迁移、对应条目写入或 pending 恢复时更新。
- 小详情、INDEX 和 MEMORY 使用临时文件原子替换；大详情继续使用临时目录整套切换。writer 的详情读取与写入进入同一串行队列；只读 Host 读取前刷新 v2 父状态，详情记录 ENOENT 时再刷新并重试，以观察其他 Host 已提交的纠正和删除。
- `audit.v1.jsonl` 只记录操作、id、revision、时间和脱敏结果，不记录记忆正文、秘密或完整提示词。
- `global/INDEX.md` 包含全局条目与所有 workspace 的 id、条目数、revision、更新时间引用；不复制 workspace 详情。
- 每会话独立保存两个层的 `enabled`、`desiredInjections`、已提交 injection id/revision 和估算 token。
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
- 测试忘记只删除目标条目，不影响其他条目、Session 或注入历史。
- 模拟锁占用、stale lock、写失败、损坏 JSON、截断审计尾和崩溃残留 tmp。
- 验证同 root 第二写者只读，旧 fencing token 不能提交。
- 验证 Markdown 注入转义、Unicode、CRLF/LF 与确定性输出。
- 验证 8,000/8,001 阈值、4,000 硬上限、语义边界与无空白长正文、分片拼接逐字符还原。
- 验证分片目录投影、父索引单项链接、纠正缩片/取消分片及删除后的陈旧文件清理。
- 用文件读取观测证明启动和 `list()` 不读取详情记录，第一次 `read()` 只读取目标 id/revision；v2 父状态不含正文。
- 验证 v1 迁移内容无损、迁移失败保留 v1、只读 Host 可兼容读取未迁移 v1，详情记录或投影写失败不推进父 revision，纠正后旧版本及删除后的权威详情被清理。
- 注入父状态、详情记录、分片和索引写失败，验证提交前恢复旧投影、提交后返回 committed 结果、pending 在重开后恢复，以及本地 read/remove 串行和第二 Host 纠正/删除可见性。
- 验证保留期清理只消费父索引，不读取 `detail-data`。

## Boundaries

- Always：所有数据留在 snail_memory；原子写；单写者；删除只作用于本插件数据。
- Ask first：改变持久格式、引入数据库、扩大可读取目录。
- Never：修改 dsh 源码或 Session；把正文/秘密写进审计；用 workspace path 代替 WorkspaceId。

## Success Criteria

- 所有 CRUD 和会话状态在重启后一致。
- 全局与 workspace 索引不串层，Ungrouped 不会生成 workspace 目录。
- 任意写失败不破坏最后一个已提交状态。
- 忘记后 list/read 均不可取得条目，详情文件和分片目录被移除，审计无正文。
- 大详情主索引不随分片数增长，投影与工具均可确定性重建，旧分片不残留。
- 测试、typecheck、build 通过。

## Open Questions

无阻塞项。当前采用父索引快照与版本化详情记录，不引入数据库；只有实测规模证明需要索引数据库或详情缓存时才另提 Spec 变更。
