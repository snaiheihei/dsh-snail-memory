# Spec: memory-lifecycle

## Objective

实现显式记忆操作和自动记忆生命周期：每 10 个有效用户轮轻量 Review、15 分钟空闲或结束蒸馏、dirty 时最多每 6 小时全局整合、每 24 小时遗忘清理。

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
src/lifecycle/llm.ts        → 一次性辅助模型调用与 JSON 解析
src/lifecycle/distill.ts    → 会话候选蒸馏与幂等提交
src/lifecycle/consolidate.ts→ 去重、合并、冲突修正、摘要更新
src/lifecycle/retention.ts  → 分类保留与每日清理
src/lifecycle/service.ts    → remember/correct/forget 与事件装配
tests/lifecycle/            → 事件、调度、预算和失败测试
```

## Configuration Defaults

- `reviewEveryUserTurns = 10`；仅真实 `source.kind === 'user'`，且所在 turn `completed` 后触发。
- `idleDelayMinutes = 15`；新活动取消旧 idle timer，dispose 不再启动 maintenance。
- `consolidationCooldownHours = 6`；dirty 为必要条件，成功或失败后记录持久结果，重启不错过到期任务。
- `retentionSweepHours = 24`。
- 保留期：环境事实 30 天、项目约定/排障经验 180 天、用户偏好/长期决策不自动过期；过期结论先从未验证时间判定。
- Review 输入最多 24,000 字符，蒸馏最多 48,000 字符，整合最多 64,000 字符；详情单条最多 16,000 字符。
- 注入索引上限 1,200 估算 token，核心摘要上限 800 估算 token；超出时保留最新高置信条目并报告截断。

## Code Style

```ts
if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
const pending = this.pendingTurns.get(sessionId)
pending?.count += 1
```

任务以持久 intent + idempotency key 串行执行；post-commit 事件只负责观察，不承担写事务。LLM 失败保留 dirty 和可重试状态，不伪造成功。

## Testing Strategy

- 注入、schedule、runtime-context 不计有效轮；aborted/error 不触发 Review。
- 第 9/10/11 轮边界、重启恢复、重复事件和乱序通知。
- idle debounce、非 idle maintenance 竞态、dispose、archive/stop。
- 6 小时冷却、dirty gate、每日清理、单 timer 和卸载 drain。
- LLM 空输出、非 JSON、部分有效候选、秘密输出、超时和重试。
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
