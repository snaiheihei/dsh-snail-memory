# Spec: global-aggregate-memory

> 2026-10-28 独立 Global 修订：文件名保留用于历史追踪，但“动态只读聚合”契约已废止。Global 改为用户通过 Promote 建立的独立权威记忆库；Session 三态单选、单快照和跨 workspace 召回规则继续有效。

## Objective

把 Global memory 从所有 workspace 的动态聚合视图改为人工精选、独立维护的长期记忆。用户可从任意 workspace 的记忆详情弹窗执行 Promote，复制完整索引和详情到 Global；复制后来源与副本双向隔离，Global 可独立删除和整合。

### 已确认决策与假设

1. 按钮语义为 Promote（提升至全局），不是提示词 Prompt。
2. Promote 是深复制：新 Global ID、独立权威详情记录和独立 Markdown/分片投影；不共享来源详情文件，不自动同步或反向覆盖。
3. `promotedFrom = { workspaceId, id }` 记录来源并用于幂等。来源仍现存且 Global 副本仍存在时，重复/并发 Promote 返回同一副本，不增加 revision、不设置 dirty；用户删除 Global 副本后再次显式 Promote 可创建新副本。
4. 不携带来源 `supersedes`，避免跨 scope 悬空引用；保留 category、summary、detail、sourceRefs 和内容时间语义，新副本获得自己的 createdAt/updatedAt/revision。
5. Global tab 只显示独立 Global 条目，可删除；删除 Global 不影响来源，删除来源不影响 Global，均不修改 Session 或任何蒸馏游标。
6. 旧动态聚合不批量迁移；已有 workspace 记忆不变，旧独立 Global 数据按权威记录恢复可见，但不因此自动调度 LLM 整合。
7. 旧 Global revision 是聚合值。首次加载旧格式时建立不低于旧聚合 revision 的独立基线，保证已有 Global 快照在首次 Promote 后能正确 Refresh；不得让后续 workspace 写入继续推进 Global revision。

## Tech Stack

TypeScript、React 18、dsh Cordis Host/Client 扩展点、MemoryStore JSON 权威状态、版本化详情 JSON、Markdown 投影、Vitest、Testing Library、Node >=22.19。

## Commands

```sh
npm test -- tests/store tests/lifecycle tests/context tests/api tests/client
npm test
npm run typecheck
npm run lint
npm run build
```

## Project Structure

```text
src/store/           → 独立 Global 条目、事务内 Promote、revision 与详情投影
src/lifecycle/       → Global 独立 dirty、7 天整合调度和 scope 内 LLM 整合
src/context/         → 三态单选、独立 Global 快照和详情读取
src/api/             → Promote、Global read/remove 和设置校验
client/src/          → 详情 Promote/Delete、独立 Global tab 和 Settings
tests/               → Store、生命周期、Context、API 和 Client 行为测试
.qoder/plan/         → 本规格及相关模块规格
```

## Code Style

```ts
const promoted = await store.promote(
  { kind: 'workspace', workspaceId },
  sourceId,
)
if (promoted.created) await scheduler.markGlobalDirty()
```

沿用不可变输入、Host 权威状态、窄类型 Scope/WorkspaceId、显式错误、单写者事务和 append-only 注入。Promote 去重和正文复制必须在同一 Store 写队列中完成，不能依赖按钮禁用代替 Host 幂等。

## Behavior Contract

### 独立存储与 Promote

- `list({ kind: 'global' })` 只返回 `scope.kind === 'global'` 的条目，`workspaces` 管理投影为空；维护任务通过内部 workspace 枚举入口，不再依赖 Global 聚合。
- Global 读取、快照、工具详情、Markdown INDEX/MEMORY 和删除使用同一组独立权威条目。
- Promote 只接受已注册 workspace 来源，拒绝 global→global；普通 remember/correct 仍不开放 Global 写入，创建入口集中在 Promote 和 Global consolidation。
- 长正文通过现有版本化详情记录和确定性分片管线派生，不直接复制 Markdown 投影目录。
- Global 条目后续 upsert/consolidation 必须保留 `promotedFrom`；来源 correction、supersedes、retention 或删除均不同步。

### 生命周期隔离

- `globalConsolidationCooldownDays = 7`，Settings 可调整；workspace `consolidationCooldownHours = 20` 保持独立。
- Promote 新建、Global 删除和 Global 内容变化只设置 `globalDirty` 并重排 `nextGlobalConsolidationAt`；workspace 变化只设置原 `dirty`。
- 新增独立 Global consolidation intent，与 workspace consolidation 共用单 timer/串行队列，但成功、失败、重试和设置热更新只清理或重排自己的目标字段。
- Global consolidation 只读取和写回 Global scope，可在 Global 内去重、冲突修正和 supersedes；不得读取或删除来源 workspace 条目。
- Review/Idle/Stop 只写 Session owner workspace，不创建 Global 条目，也不改变 Global dirty/时间；retention 只清理 workspace，即使 Global 条目带显式 expiresAt 也不由该任务删除。
- 两类 scope 共用 `snapshotTokenBudget`，只影响后续 Enable/Refresh 新快照；已有注入历史不改写。

### 状态与 Session 兼容

- 新元数据采用 additive normalization，旧状态缺省为 `globalDirty=false`、时间为 null，不自动发起 Global LLM 工作。
- 旧 Global 聚合 revision 只用于一次性独立基线；迁移后 Global revision 仅由独立 Global 写入推进。
- 每个 Session 继续表现为关闭/workspace/global 三态之一，单 active desired、单 pre-step 准入和单用户轮 committed 不变。
- 删除和 Promote 不读取、重置或推进 `distillationCursor`，不删除 dsh Session 消息。

## Testing Strategy

先修改或新增测试并确认旧实现失败，再实现：

- Store：独立 Global 列表/revision/投影、顺序及并发 Promote 幂等、长正文与全部分片、新 ID/provenance、双向删除和内容隔离、旧字段与 revision 基线恢复。
- 生命周期：workspace 20 小时与 Global 7 天分别到期、热更新、重启恢复、一方失败不影响另一方；Global consolidation 严格 scope 隔离；Review/Idle/Stop 和 retention 不触碰 Global。
- API/Context：Promote 校验、只读 Host、未知 workspace、Global read/remove；Global 快照无 workspace 聚合引用，旧快照可 Refresh，详情读取无需 workspace_id，共用快照预算。
- Client：workspace 详情 Promote、重复操作反馈、Global 删除、Global 无来源聚合列表、Settings 加载和保存 7 天值。
- 最后运行完整测试、三种 typecheck、lint 和 build；不把单元测试等同于真实 Host/UI/模型验收。

## Boundaries

- Always：保留用户已有数据；先 RED 后 GREEN；Host 幂等；单写者与串行生命周期；注入 append-only。
- Ask first：自动批量迁移或同步 Global；引入新依赖、数据库或跨 scope 自动晋升；改变 dsh Session 日志。
- Never：修改 deepseek-harness tracked 文件；共享来源与副本详情所有权；用删除记忆修改游标或对话；安装到真实 Host 或重启用户进程。

## Success Criteria

1. Global 的列表、投影、快照、详情和删除只来自独立 Global 权威条目。
2. Promote 完整复制且幂等，来源与副本后续更新、删除和整合互不影响。
3. Global 默认 7 天独立整合，workspace 20 小时行为不回归；retention 和 Session 蒸馏不影响 Global。
4. 旧状态不丢数据、不自动发起 Global LLM，旧 Global 快照能在新 revision 后 Refresh。
5. 相关 Spec 与演化文档同步，完整测试、typecheck、lint、build 通过。

## Open Questions

无。真实 Host/UI 的隔离安装验证不在本次自动修改的默认执行范围内，最终需明确报告。
