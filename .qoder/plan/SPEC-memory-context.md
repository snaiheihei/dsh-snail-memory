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
src/context/tool.ts           → snail_memory_read 受限详情与分片读取工具
tests/context/                → latch、revision、顺序、恢复和分片读取测试
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
- `readDetail()` 异步按父索引中的 id/revision 读取目标权威详情记录；enable、refresh 和快照渲染只消费内存父索引，不预读完整详情。工具输出契约不因存储懒加载而改变。

### 大详情读取契约

- 未分片记忆只传 `layer + memory_id` 时保持原契约，返回父摘要、完整 detail 和最近验证时间。
- 分片记忆只传 `layer + memory_id` 时返回父摘要、最近验证时间及有序分片清单，不返回任何分片正文；清单仅含 `chunk_id`、序号、字符数和估算 token，供模型二次选择。
- 分片记忆同时传 `chunk_id` 时只返回该分片正文及父元数据，不夹带其他分片或完整父 detail。`chunk_id` 使用 `part-NNN`，只在所属父条目内解释。
- 未分片记忆传入任意 `chunk_id`（包括空字符串）、未知或空 `chunk_id`、未知父记忆均返回未找到，不得以返回完整父 detail 作为降级。
- 工具 output schema 必须区分清单与单片结果；分片清单不得通过 `detail` 或 preview 泄漏正文。模型可见内容仍经普通工具调用/结果进入 Session，本功能不增加或改写 Session 日志。
- 分片不改变常驻快照、enable、refresh revision、desired/committed 语义；主快照继续只含父摘要。

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
- 大详情默认清单无正文、指定单片无其他正文、未知分片未找到、未分片读取完全兼容。
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
- 大详情默认读取不返回正文，单片读取只返回目标分片；未分片与越权行为无回归。
- 无 system prompt 头部污染，无记忆删除或分片引起的对话修改。

## Open Questions

无阻塞项。若 dsh inbox 在运行 turn 中选择后续 step 而非下一次人类提问，本插件保持宿主语义并在 UI 显示“已排队”，不伪造精确顺序保证。
