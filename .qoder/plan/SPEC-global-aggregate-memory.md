# Spec: global-aggregate-memory

## Objective

把全局记忆改成所有 workspace 记忆的动态、只读聚合，不再维护独立全局条目；同时把每个 Session 的记忆注入改为“关闭 / 当前 workspace / 全局”三态单选。用户选择全局时，列表、Markdown 投影、注入快照和详情读取均来自同一组 workspace 权威条目，不经过辅助模型二次整合。

### 已确认决策与假设

1. 采用动态聚合，不生成 global 副本，不做跨 workspace LLM 去重或冲突裁决。
2. global 不再接受 remember/correct/forget；全局视图只读，删除仍进入具体 workspace 视图执行。
3. 旧版独立 global 条目保留在权威 JSON 和详情数据中，但不进入新的 global 列表、投影、快照、整合或保留期清理；不擅自删除或迁移到某个 workspace。
4. 每个 Session 保留现有两层 desired/committed 历史，但 enabled 最多一层为 true。旧数据若两层同时启用，以当前 workspace 为选中层，避免扩大注入范围。
5. 切换或关闭只影响后续恢复和新注入，不删除已提交快照，也不声称能撤回已经进入 dsh Inbox 的消息。

## Tech Stack

TypeScript、React 18、dsh Cordis Host/Client 扩展点、既有 MemoryStore JSON 权威状态与 Markdown 投影、Vitest、Testing Library、Node >=22.19。

## Commands

```sh
npm test -- tests/store tests/context tests/api tests/client
npm test
npm run typecheck
npm run lint
npm run build
```

## Project Structure

```text
src/store/           → workspace 权威条目、global 动态索引和 Markdown 投影
src/context/         → 单选 enable/disable、快照恢复和带来源的详情读取
src/lifecycle/       → 仅整合/清理 workspace 条目
src/api/             → RPC disable、global 写入拒绝和命令提示
client/src/          → 三态单选 Composer、全局聚合列表和来源详情
tests/               → Store、Context、API、生命周期和 Client 行为测试
.qoder/plan/         → 本规格及既有插件规格
```

## Code Style

```ts
await this.store.updateSessionState(sessionId, state => {
  for (const candidate of ['global', 'workspace'] as const) {
    state.layers[candidate].enabled = candidate === layer
  }
})
```

沿用不可变输入、Host 权威状态、窄类型 Scope/WorkspaceId、显式错误和 append-only 注入。聚合条目保留原 `entry.scope`，global 不伪造新的条目 id 或来源。

## Behavior Contract

### Global 动态聚合

- `list({ kind: 'global' })` 汇总所有已登记 workspace 的条目；每条保留原 scope、id、revision 和时间。
- global revision 随任一 workspace 条目写入、纠正或删除单调前进，用于既有 refresh 对账；Session 状态更新不应提高 global revision。
- global 快照直接包含预算内的各 workspace 摘要，并显示来源 workspace；不再只列 workspace 引用，也不包含旧 global 条目。
- global 详情读取必须提供来源 workspace，避免跨 workspace 同 id 的歧义；当前 Session 必须选中 global。
- global 与 workspace 的 Markdown 索引/核心摘要均从同一聚合规则生成。
- 自动 Review/idle/stop 仍只写当前 workspace；整合和保留期清理只处理 workspace 条目。

### Session 三态单选

- 新 Session 默认关闭。
- enable(global) 或 enable(workspace) 原子地选中目标并取消另一层；重复选择当前层维持幂等恢复。
- 新增 disable，将两层 enabled 都设为 false，不删除 desired/committed。
- restore 只恢复当前选中层的 pending injection；关闭层的历史 pending 不得因重启或切换而继续排队。
- refresh 只允许当前选中层；Ungrouped Session 仍不能选择 workspace，但可选择 global。
- Composer 提供“关闭 / 当前 workspace / 全局”单选控件和当前层 refresh；旧 Session 的异步响应不得覆盖新 Session。

## Testing Strategy

先修改或新增测试并确认在旧实现上失败，再实现：

- Store：global 汇总多个 workspace、排除旧 global、revision 前进、详情按来源读取、Markdown 一致。
- Context：两层互斥、disable、旧双层状态归一化、关闭层 pending 不恢复、跨 workspace 全局快照和详情。
- API/生命周期：disable RPC、remember global 拒绝、自动蒸馏不写 global、整合/清理不触碰旧 global。
- Client：三态单选、切换调用、关闭调用、refresh 仅当前层、Ungrouped 和 stale response。
- 最后运行完整测试、三种 typecheck、lint 和 build；不把单元测试等同于真实 Host/UI/模型验收。

## Boundaries

- Always：保留用户已有数据；先 RED 后 GREEN；保持注入 append-only 和 desired/committed 对账； Host 为选中状态权威来源。
- Ask first：删除或迁移旧 global 数据；引入跨 workspace 模型整合；改变 dsh Session 日志或新增依赖。
- Never：修改 deepseek-harness tracked 文件；静默提升 workspace 条目为独立 global；改写已注入历史；安装到真实 Host 或重启用户进程。

## Success Criteria

1. global 的列表、投影和快照只来自所有 workspace 的当前权威条目，并保留来源。
2. 任何公开写入路径都不能新增、纠正或删除独立 global 条目；旧 global 数据不被自动清理。
3. 每个 Session 在 Host 和 Composer 中均表现为关闭、workspace、global 三态之一，重启后保持一致。
4. 切换/关闭后，未选层不会发生新的恢复注入；既有 committed 历史不变。
5. 新增测试先证明旧行为不满足，最终完整测试、typecheck、lint、build 通过。

## Open Questions

无。真实 Host/UI 的隔离安装验证不在本次自动修改的默认执行范围内，最终需明确报告。
