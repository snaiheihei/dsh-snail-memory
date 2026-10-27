# Spec: memory-lifecycle

> 2026-10-27 修订：自动蒸馏、整合和保留期只处理 workspace；global 是动态只读聚合，旧 global 条目不参与后台维护。以 `SPEC-global-aggregate-memory.md` 为当前契约，本文其余调度与重试规则继续有效。

## Objective

实现显式记忆操作和自动记忆生命周期：每 15 个有效用户轮轻量 Review、60 分钟空闲或结束蒸馏、dirty 时最多每 20 小时 scope 内整合、每 24 小时遗忘清理。

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
src/lifecycle/scheduler.ts  → nextRunAt、dirty、单 timer、重启恢复
src/lifecycle/settings.ts   → UI 设置校验、原子持久化与只读边界
src/lifecycle/llm.ts        → 一次性辅助模型调用与 JSON 解析
src/lifecycle/distill.ts    → 会话候选蒸馏与幂等提交
src/lifecycle/consolidate.ts→ 去重、合并、冲突修正、摘要更新
src/lifecycle/retention.ts  → 分类保留与每日清理
src/lifecycle/service.ts    → remember/correct/forget 与事件装配
tests/lifecycle/            → 事件、调度、预算和失败测试
```

## Configuration Defaults

- `reviewEveryUserTurns = 15`；仅真实 `source.kind === 'user'`，且所在 turn `completed` 后触发。
- `idleDelayMinutes = 60`；新活动取消旧 idle timer，dispose 不再启动 maintenance。
- `consolidationCooldownHours = 20`；dirty 为必要条件，成功或失败后记录持久结果，重启不错过到期任务。
- Settings 页可调整上述三项、`snapshotTokenBudget` 和五类 `retentionDays`；`settings.v1.json` 原子持久化并优先于启动默认值，旧文件缺少新增字段时补用对应默认值。保存后保留轮计数、重排已有 idle intent 和 dirty/consolidation 计划，只读 Host 拒绝更新。
- Workspaces 页从完整 WorkspaceRegistry 选择任意已注册 workspace 并读取其索引，不以当前 Session 或已有记忆引用为限。
- `retentionSweepHours = 24`。
- 首次加载只恢复已有记忆、调度和注入状态，不自动遍历并蒸馏全部历史 Session；历史回填不是默认生命周期任务。
- 默认保留期：环境事实 30 天、项目约定/排障经验 180 天、用户偏好/长期决策 0 天（不自动过期）；五类均可配置，修改从下一次每日清理生效，显式 `expiresAt` 始终优先。过期结论先从最近验证时间判定。
- Review 输入最多 24,000 字符，蒸馏最多 48,000 字符，整合最多 64,000 字符；详情单条最多 16,000 字符。
- Review/蒸馏的转录投影仅保留真实用户消息、助手消息和普通工具结果；通过 `tool/call.callId` 排除 `snail_memory_read` 的 `tool/result`，不按结果正文过滤，也不修改原始 Session。
- 注入索引默认上限 1,200 估算 token，可在 Settings 调整 `snapshotTokenBudget`；新值仅用于后续 Enable/Refresh 新快照，不改写历史快照。核心摘要上限 800 估算 token；超出时保留最新高置信条目并报告截断。

## Code Style

```ts
if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
const pending = this.pendingTurns.get(sessionId)
pending?.count += 1
```

任务以持久 intent + idempotency key 串行执行；post-commit 事件只负责观察，不承担写事务。LLM 失败保留 dirty 和可重试状态，不伪造成功。

## Testing Strategy

- 注入、schedule、runtime-context 不计有效轮；aborted/error 不触发 Review。
- 第 14/15/16 轮边界、重启恢复、重复事件和乱序通知。
- idle debounce、非 idle maintenance 竞态、dispose、archive/stop。
- 20 小时默认冷却、dirty 设置热更新与计划重排、dirty gate、每日清理、单 timer 和卸载 drain。
- 五类保留期默认值、持久化与 RPC 校验；`0` 天关闭类别过期，自定义策略在下一次清理生效，显式过期时间优先。
- 快照预算默认值、旧配置兼容、RPC/UI 保存，以及预算变更只影响后续新快照。
- LLM 空输出、非 JSON、部分有效候选、秘密输出、超时和重试。
- `snail_memory_read` 结果不进入蒸馏输入，普通工具结果继续保留。
- 验证整合不跨 scope 自动晋升，不修改 Session。

## Boundaries

- Always：先安全扫描；持久 intent；串行写；保留可重试失败。
- Ask first：改变频率默认值、增加自动 scope 晋升或新模型路由。
- Never：用 jobs-local 代替持久恢复；在 post-commit 回调里阻塞 Session；删除对话历史。

## Success Criteria

- 所有触发频率和边界符合默认值。
- 自动蒸馏只写入当前已验证 workspace；Ungrouped 不自动写全局。
- 整合在 scope 内去重、合并、修正冲突、删除过期结论并更新摘要/索引。
- 显式 remember/correct/forget 无需等待 Review，立即持久化并广播变化。
- 崩溃重启后任务不丢、不重复提交同一 intent。

## Open Questions

无阻塞项。首版 Review/蒸馏使用当前可用模型路由；无可用路由时显式报告并保留 dirty，不创建虚假记忆。
