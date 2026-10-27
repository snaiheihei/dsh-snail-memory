# Spec: memory-store

## Objective

为 Snail Memory 提供单用户、全局/workspace 分层的持久存储。存储是所有读写、索引展示、注入 revision 和删除语义的权威来源；原始 Session 永远不由本模块修改。

验收结果：重启后记忆与会话开关状态可恢复；全局索引包含 workspace 引用；忘记后条目正文和索引不再可读；异常写入不会暴露半条 JSON 或半条 Markdown。

## Tech Stack

TypeScript、Node.js 22 `node:fs/promises`、JSON 权威快照、JSONL 无正文审计事件、Markdown 可读投影、Vitest。运行数据全部位于 `resolveDshHome(configuredHome)/snail_memory`。

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
src/store/json.ts        → 原子 JSON 写入、恢复和校验
src/store/projections.ts → INDEX.md、MEMORY.md、详情 Markdown
src/store/store.ts       → 串行读写、revision、审计与删除
tests/store/             → Temp 目录单元和崩溃恢复测试
```

## Data Contract

- `MemoryScope` 为 `{ kind: 'global' }` 或 `{ kind: 'workspace', workspaceId }`；目录只使用 branded id 的字符串值。
- `MemoryEntry` 包含 `id`、`scope`、`category`、`summary`、`detail`、`createdAt`、`updatedAt`、`lastVerifiedAt`、`revision`、`sourceRefs`，以及可选 `expiresAt`、`supersedes`。
- 五类 category 为 `preference`、`project-convention`、`environment-fact`、`troubleshooting`、`long-term-decision`。
- 当前状态由单一 `state.v1.json` 原子发布；Markdown 是可重建投影，不是第二份权威数据。
- `audit.v1.jsonl` 只记录操作、id、revision、时间和脱敏结果，不记录记忆正文、秘密或完整提示词。
- `global/INDEX.md` 包含全局条目与所有 workspace 的 id、条目数、revision、更新时间引用；不复制 workspace 详情。
- 每会话独立保存两个层的 `enabled`、`desiredInjections`、已提交 injection id/revision 和估算 token。
- 普通更新不改 Session；格式迁移创建新 successor。显式隐私删除允许清理本插件旧数据世代，但不允许删除 Session 世代。

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

严格 TypeScript；跨文件、JSON、RPC 边界校验，内部已类型化值不重复做防御性 any/unknown cast。所有写操作经同一串行队列，成功持久化后才更新内存。

## Testing Strategy

- 临时目录测试全局/workspace 隔离、索引引用、revision 和重启恢复。
- 测试忘记只删除目标条目，不影响其他条目、Session 或注入历史。
- 模拟锁占用、stale lock、写失败、损坏 JSON、截断审计尾和崩溃残留 tmp。
- 验证同 root 第二写者只读，旧 fencing token 不能提交。
- 验证 Markdown 注入转义、Unicode、CRLF/LF 与确定性输出。

## Boundaries

- Always：所有数据留在 snail_memory；原子写；单写者；删除只作用于本插件数据。
- Ask first：改变持久格式、引入数据库、扩大可读取目录。
- Never：修改 dsh 源码或 Session；把正文/秘密写进审计；用 workspace path 代替 WorkspaceId。

## Success Criteria

- 所有 CRUD 和会话状态在重启后一致。
- 全局与 workspace 索引不串层，Ungrouped 不会生成 workspace 目录。
- 任意写失败不破坏最后一个已提交状态。
- 忘记后 list/read 均不可取得条目，详情文件被移除，审计无正文。
- 测试、typecheck、build 通过。

## Open Questions

无阻塞项。首版采用单 JSON 权威快照而非数据库；只有实测规模证明需要索引数据库时才另提 Spec 变更。
