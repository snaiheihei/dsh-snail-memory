# Spec: memory-context

> 2026-10-29 rank 反馈修订：快照记录实际渲染的 memory ID 并提供简短反馈提示；新增 `snail_memory_feedback`，只允许对已提交快照中实际出现的条目按 Session + injection + memory 幂等反馈。
>
> 2026-10-28 独立 Global 修订：global 快照与详情只读取独立 Global 条目，不再聚合或要求来源 workspace；三态单选、单 active desired 和跨 workspace 召回保持不变。
>
> 2026-10-28 跨 workspace 修订：workspace 召回可选择任意已注册项目；`selectedWorkspaceId` 与 Session 写入 owner 分离，refresh 按目标项目独立 revision 对账。

## Objective

实现每会话关闭/workspace/global 三态选择、一次性自动摘要注入、显式 refresh、跨 workspace 召回、时效提醒和受限详情读取，保证所有模型可见记忆均可由 dsh Session 重建，且召回选择不改变自动蒸馏与显式写入归属。

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
src/context/snapshot.ts       → 摘要、实际渲染 ID、时效、不可信与反馈提示渲染
src/context/injection.ts      → desired/queued/committed 对账
src/context/service.ts        → enable、refresh、恢复、统计和反馈委托
src/context/tool.ts           → snail_memory_read 详情/分片读取与 snail_memory_feedback 工具
tests/context/                → latch、revision、顺序、恢复、分片读取和反馈资格测试
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

- 新会话无状态即两层 disabled；关闭/workspace/global 为三态单选。每个 Session 同时最多一个 `activeDesired = { layer, injectionId }`，历史 desired 仅用于准入后的提交对账，不再都具有待注入资格。
- enable(workspace) 可携带任意已注册 `workspaceId`，包括非 Session 所属项目；Ungrouped Session 也可显式选择已注册项目。`selectedWorkspaceId` 只决定 workspace 快照、refresh 和详情读取，原 `workspaceId` 仍是 Session 自动蒸馏与显式写入归属，召回选择不得覆盖它。
- enable 原子持久化层选择、召回项目和 active desired，再尝试排队；只有重复选择当前层且 workspace 选择相同才幂等恢复，切换层或召回项目时按目标 scope 当前 revision 渲染新代，不能复用旧 automatic desired。
- 快照渲染同时返回正文与 `memoryIds`，只有实际加入预算内快照的父条目才进入清单；被 token 预算停止的条目不得进入。commit 时把同一清单复制到 committed injection，旧记录缺省该字段时保持兼容但不授予反馈资格。
- 快照尾部包含简短反馈说明：仅在实际采用某条记忆，或明确发现其无帮助/不正确时调用 `snail_memory_feedback`；不要因注入或读取本身评分，也不要批量自评。
- refresh 仅在当前 scope revision 高于该 scope 最新 desired revision 时创建新代；不同 workspace 的 revision 分别对账，不得跨项目取最大值。同一发送前多次 refresh 只保留最新 active desired。disable 清除 active desired。
- restore 先按 Session 中已提交的 Snail `user/message` 对账，再通过公开 `agent.inbox.replace/remove` 收敛未 claim 消息：保留一个 active 快照，移除 stale/duplicate 快照，缺少 active 时才 `agent.inject()`。普通用户和其他插件消息不得被修改。
- `agent/pre-step` 必须先 `await next()`，再过滤最终 enter decision。每个 turn 最多准入一份与 active desired 匹配的 Snail 快照；已 claim 的 stale 快照在此拦截，新 active 等后续提交，不插入当前 decision。reject decision 原样返回。
- pre-step 记录实际 admitted injection id。post-commit 只按该 id 提交；pre-step 后发生 switch/refresh 时，旧 admitted 仍如实 committed，新 active 保持 pending。每个 turn 的后续 step 不得再准入第二份 Snail 快照；被过滤的新 active 在 `agent/status` 回到 idle 后通过 restore 重新排队。
- 相同 injection id 不得重复 committed 计数；重复通知不重复 token 统计。重启时即使插件尚未持久化 committed，也能从 Session 历史补齐并避免再次注入；只读 Host 同样根据 Session 历史抑制重复注入，但不尝试写入 committed。
- 已提交快照和 committed 历史永不 replace 或追溯改写；忘记只影响未来快照和详情读取，也不改变蒸馏游标。
- `snail_memory_read` 仅接受当前 Session 已启用 scope 和已知 MemoryId；workspace 层按 `selectedWorkspaceId` 读取，Global 层直接读取独立 Global 条目，均不开放任意路径。
- `readDetail()` 异步按父索引中的 id/revision 读取目标权威详情记录；enable、refresh 和快照渲染只消费内存父索引，不预读完整详情。工具输出契约不因存储懒加载而改变。

### 使用反馈契约

- `snail_memory_feedback` 参数仅为 `layer`、`memory_id`、`outcome`，outcome 枚举为 `helpful | unhelpful | incorrect`；Session 从 `exec.agent` 获取，workspace 由 Host 当前召回选择推导。工具不接收任意 delta、reason、injectionId、workspace 或正文。
- `helpful` 将 rank +1，`unhelpful` 与 `incorrect` 将 rank -1。`incorrect` 只是负反馈，不自动纠正或删除记忆，rank 也不表示内容已经验证为正确。
- 只有目标 memoryId 实际出现在当前 Session 对应 layer 的 committed 快照中才可反馈；仅 desired/queued、被预算省略、仅被读取、旧无 memoryIds 的快照均返回 not-injected。未启用、目标不存在或不属于当前 scope 分别返回 disabled/not-found。
- 同一 Session + injectionId + memoryId 只接受一次，重复返回 duplicate 和当前 rank；重启后仍由 committed 回执防重，新的 committed injection 可再次反馈。反馈结果只包含 status 和可选 rank，不返回记忆正文。
- rank-only 更新走 Store 专用原子事务，不改变内容 revision、scope revision、内容时间、dirty、调度、游标、active desired 或快照顺序；Store 列表和模型召回继续按 updatedAt/id，只有 Web 管理列表按 rank 排序。

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

- 默认 disabled、重复 enable 同一召回项目幂等、disable 撤回未提交 active、两层切换只留一份 pending。
- workspace A→B 直接切换只留一份 active/pending，快照与详情来自 B，Session 写入 owner 保持不动；Ungrouped 可选择已注册项目。
- 同 scope 同 revision refresh no-op；另一 workspace 的更高 revision 不阻塞当前项目刷新；多次新 revision refresh 合并为最新 active。
- pre-step 保留普通消息和下游 decision，过滤 stale/duplicate Snail；同 turn 后续 step 不再准入。
- pre-step 后 switch/refresh 仍提交 admitted 旧代，新代等待后续 turn；未 admitted 的 stale 事件不得 committed。
- queued 后重启最多恢复一份；Session 已提交但 committed 尚未落盘的崩溃窗口不会重复注入；重复 session/event 幂等。
- workspace 缺失/删除、未注册项目和详情工具越权。
- 大详情默认清单无正文、指定单片无其他正文、未知分片未找到、未分片读取完全兼容。
- 快照包含 revision、生成时间、天数提醒、不可信提示与反馈说明，且正文可重建。
- desired/committed 只保存实际渲染的 memoryIds，预算省略条目不进入；反馈接受、重复、未注入、未启用、错误 scope、重启幂等和新 injection 再反馈均有覆盖。
- 反馈工具结果不泄漏 summary/detail，rank 更新不改变注入和生命周期状态。
- 验证估算 token 只统计已提交 injection。

## Boundaries

- Always：append-only；Host 权威状态；提交后才计 token。
- Ask first：新增 surface replacement、自动每步召回或修改 system prompt。
- Never：把 agent.inject 返回当持久化 ACK；修改旧记忆消息；开放路径读取。

## Success Criteria

- reload、Host 重启和另一浏览器均恢复相同开关、召回项目与提交状态。
- enable 后最新可用摘要只自动注入一次；跨 workspace 切换仍保持单 active，refresh 按当前项目独立 revision 对账。
- 所有进入模型的记忆均表现为普通 Session 用户/工具事件。
- 大详情默认读取不返回正文，单片读取只返回目标分片；未分片与越权行为无回归。
- 反馈只能针对 committed 快照中实际渲染的条目，同一 injection 内幂等且重启可恢复；rank 不改变召回、刷新或快照注入顺序。
- 无 system prompt 头部污染，无记忆删除或分片引起的对话修改。

## Open Questions

无阻塞项。若 dsh inbox 在运行 turn 中选择后续 step 而非下一次人类提问，本插件保持宿主语义并在 UI 显示“已排队”，不伪造精确顺序保证。
