# Spec: memory-safety

> 2026-10-29 活动日志修订：生命周期活动记录采用显式字段白名单，只保存调度、批次、游标位置、稳定错误分类和重试元数据，不保存对话、提示词、记忆正文、模型原始响应或异常原文。
>
> 2026-10-29 rank 反馈修订：反馈工具只接受枚举 outcome 与受限 ID，不开放自由文本 reason 或任意 delta；结果不返回记忆正文，并像其他模型可见工具结果一样保留在 Session、但从后续蒸馏输入排除。

## Objective

在记忆候选进入持久化或辅助模型之前实施来源准入、秘密扫描、脱敏和不可信内容提示。安全模块无存储和 LLM 依赖，可独立测试。

## Tech Stack

TypeScript、Node.js 22、确定性正则/状态扫描器、Vitest。不得把 Host 安全逻辑放到浏览器端。

## Commands

```sh
npm run test -- tests/safety
npm run typecheck
npm run lint
```

## Project Structure

```text
src/safety/scanner.ts   → 密钥、私钥、URL 密码和常见 token 扫描
src/safety/redact.ts    → 占位符替换与保守拒绝
src/safety/policy.ts    → 来源准入、时效提醒、不可信数据提示
src/safety/types.ts     → ScanResult、RedactionFinding、SafetyError
tests/safety/           → 正反向样例和日志泄漏测试
```

## Code Style

```ts
export interface SanitizedText {
  readonly text: string
  readonly findings: readonly RedactionFinding[]
}

export function sanitizeBeforeUse(input: string): SanitizedText {
  return redactDetectedCredentials(input)
}
```

扫描器返回结构化 finding，不返回被检测秘密原文。扫描先执行总字符预算，正则必须避免灾难性回溯；局部脱敏长度上限不得成为绕扫手段。赋值凭据超过 512 字符、PEM 未闭合或超过块预算时生成 `reject` finding 并保守失败，拒绝异常使用实际 finding 类型且不保留秘密正文。候选 finding 按起点和长度排序后，只与最后一个已接受 finding 比较，去重过程为 O(F)；重叠的 `reject` 会取代已接受的 `redact`，拒绝语义不得被去重吞掉。

## Feedback Boundary

- `snail_memory_feedback` 只接受当前启用 layer、父 memory ID 和 `helpful | unhelpful | incorrect` 枚举；Host 从工具执行上下文取得 Session，模型不能指定 Session、injection、workspace 或任意 rank delta。
- 工具不接收自由文本 reason，不返回 summary/detail/sourceRefs，只返回稳定 status 和可选 rank。`incorrect` 仅记录 -1 反馈，不自动纠正、删除或保留条目。
- 工具调用和结果仍是普通 Session 证据，不建立隐藏反馈通道；后续蒸馏投影按 callId 排除其结果，避免反馈元数据自我强化。资格、幂等和原子更新由 Host Store 保证，不能依赖提示词或 UI 防刷。

## Lifecycle Activity Boundary

- 活动日志只保存 `formatVersion/time/event/operation/intentId`、可选 Session/workspace、耗时、批次与写入/拒绝计数、processed/hasMore、`{ lastEventSeq, offset }` 游标位置、跳过原因、稳定错误分类及 retryAt/retryIntentId。
- 文件 sink 必须逐字段重建记录，不能序列化调用方传入的任意对象；即使调用方额外提供 prompt、对话、summary/detail、sourceRefs、模型原始响应、异常正文或秘密，这些字段也不得落盘。游标同样只投影两个位置字段，不保存 updatedAt 或转录。
- 模型和 Store 错误通过 `model-route-missing`、`model-request-failed`、`model-output-invalid`、`model-output-empty`、`model-output-invalid-json`、`model-output-shape-invalid`、`model-output-budget-exceeded`、`store-readonly`、`operation-aborted`、`operation-failed` 稳定分类传递，活动日志不读取或保存异常 message。四种具体输出分类分别表示空输出、无法恢复合法 JSON、顶层不是数组或 candidates 对象、输出超过字符预算；通用 `model-output-invalid` 仅作其他解析失败的兼容分类。日志写入与告警均为 best-effort，不能将已经成功的记忆任务改判失败。

## Testing Strategy

- 覆盖私钥块、JWT、常见 API key、带密码 URL、Authorization header 和赋值形式 token。
- 覆盖普通密码学词汇、项目路径和正常代码，避免明显误报。
- 验证原文不出现在 finding、异常、审计和拒绝原因中。
- 验证多行、重复秘密、Unicode、长输入与扫描预算。
- 验证超过 512 字符的赋值凭据和未闭合 PEM 都保守拒绝，异常不包含秘密正文，reject 类型不被硬编码改写。
- 验证完整候选的原始 JSON、嵌套元数据、字符串键和额外字段均参与模型输出回扫，同时保留正文原始文本的检测能力。
- 验证排序后的 finding 去重只检查最后一个已接受项，重叠私钥/凭据不会重复脱敏；Authorization 等较宽 redact 与超长凭据 reject 重叠时仍必须保守拒绝。
- 验证任何 LLM 输入和持久化入口都调用同一安全策略。
- 验证反馈工具拒绝 schema 外参数，输出不含记忆正文；工具结果保留在 Session 但不进入后续蒸馏转录。
- 验证活动 JSONL 只包含白名单字段；调用方附加 prompt/detail/exception 和游标附加时间均不落盘，失败记录只包含稳定分类而不包含异常 message。
- 验证活动文件父目录或写入失败时 record/flush/close 不向业务抛出失败，onError 自身异常也被吞没；轮转与卸载 drain 不丢失已接受且可写的记录。

## Boundaries

- Always：先扫描再外发/落盘；模型输出再次扫描；无法安全处理时跳过候选。
- Ask first：新增外部扫描服务或扩大自动采集来源。
- Never：声称能识别任意密码/PII；保存秘密隔离区；读取 `.env`、私钥或凭据文件作为自动记忆来源；把对话、记忆正文、模型原始响应、异常原文或调用方额外字段写入活动日志。

## Success Criteria

- 高置信秘密以 `[REDACTED:<kind>]` 替代；私钥块、超限赋值凭据等不可安全局部处理的内容被拒绝，不因长度或未闭合边界而漏扫。
- 自动蒸馏仅接受 Session 来源，显式记住也不能绕过扫描。
- 注入文本包含不可信参考数据和按天数计算的时效提醒。
- 反馈工具不引入自由文本或正文回传通道，结果有 Session 证据但不回流为蒸馏输入。
- 活动日志只含白名单调度元数据和稳定错误分类；额外正文/异常字段被丢弃，日志故障不改变业务结果。
- 测试不将样例秘密写入真实 snail_memory。

## Open Questions

无阻塞项。首版不承诺通用 PII 检测；UI 明确安全边界。
