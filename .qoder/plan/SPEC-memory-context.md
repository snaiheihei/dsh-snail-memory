# Spec: memory-context

## Objective

实现每会话全局/workspace 两个单向 enable latch、一次性自动摘要注入、显式 refresh、时效提醒和受限详情读取，保证所有模型可见记忆均可由 dsh Session 重建。

## Tech Stack

TypeScript、Cordis、`createUserMessage()` + declaration merging、`agent.inject()`、dsh tool registry、4 字符/token 启发式估算、Vitest。

## Commands

```sh
npm run test -- tests/context
npm run typecheck
npm run build
npm run lint
```

## Project Structure

```text
src/context/message-source.ts → snail-memory MessageSourceMap 合并
src/context/snapshot.ts       → 摘要、索引、时效与不可信提示渲染
src/context/injection.ts      → desired/queued/committed 对账
src/context/service.ts        → enable、refresh、恢复和统计
src/context/tool.ts           → snail_memory_read 受限详情工具
tests/context/                → latch、revision、顺序和恢复测试
```

## Code Style

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'snail-memory': { kind: 'snail-memory' }
  }
}

agent.inject(createUserMessage({
  content: [{ type: 'text', text: snapshot }],
  source: { kind: 'snail-memory' },
}))
```

`inject()` 只记为 queued；只有观察到带 injection id 的已提交 `user/message` 才记为 committed。快照正文含结构化 HTML 注释元数据和人类/模型可读时效提醒。

## Injection Semantics

- 新会话无状态即两层 disabled；API 不接受 disable。
- enable 原子持久化 latch 和 desired revision，再尝试排队；失败可重试，不把 queued 当 committed。
- 每层仅自动 desired 一次；refresh 仅在当前 revision 高于该层最新 desired/committed revision 时创建新 desired。
- 快照追加到已有上下文之后；运行中调用不保证打断当前 step，而是等待后续可 admitted 的输入。取消/dispose 可丢弃队列，恢复时按 desired/committed 对账。
- 相同 injection id 不得重复 committed 计数；重复通知不重复 token 统计。
- 已提交快照永不 replace；忘记只阻止未来注入和详情读取。
- `snail_memory_read` 仅接受当前 Session 已启用 scope 和已知 MemoryId，不开放任意路径。

## KV Cache Effect

- enable 首次注入：只在历史尾部追加一个 user surface node，不重写 system node 0；保留此前前缀，追加后产生新的后缀。
- refresh：新增一个尾部快照，不替换旧快照；旧前缀保留，新增内容消耗相应上下文与 token。
- 删除/忘记：不改 Session，KV Cache 和已有模型历史零变化；只影响未来快照和工具读取。
- 生命周期整合：只改 snail_memory，不影响已有 Session；下一次显式 refresh 才产生追加快照。
- dsh 分级压缩仍由宿主拥有，本插件不调用 surface replacement，不另设压缩器。

## Testing Strategy

- 默认 disabled、重复 enable 幂等、disable 请求拒绝、两层独立。
- 自动只一次、refresh 同 revision no-op、新 revision 追加。
- queued 后重启、commit 后重启、重复 session/event、取消和 dispose。
- workspace 缺失/删除、Ungrouped、详情工具越权。
- 快照包含 revision、生成时间、天数提醒、不可信提示，且正文可重建。
- 验证估算 token 只统计已提交 injection。

## Boundaries

- Always：append-only；Host 权威状态；提交后才计 token。
- Ask first：新增 surface replacement、自动每步召回或修改 system prompt。
- Never：把 agent.inject 返回当持久化 ACK；修改旧记忆消息；开放路径读取。

## Success Criteria

- reload、Host 重启和另一浏览器均恢复相同开关与提交状态。
- enable 后最新可用摘要只自动注入一次，refresh 语义符合上述约定。
- 所有进入模型的记忆均表现为普通 Session 用户/工具事件。
- 无 system prompt 头部污染，无记忆删除引起的对话修改。

## Open Questions

无阻塞项。若 dsh inbox 在运行 turn 中选择后续 step 而非下一次人类提问，本插件保持宿主语义并在 UI 显示“已排队”，不伪造精确顺序保证。
