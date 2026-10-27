# Spec: memory-safety

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

扫描器返回结构化 finding，不返回被检测秘密原文。正则必须限制长度，避免对长会话产生灾难性回溯。

## Testing Strategy

- 覆盖私钥块、JWT、常见 API key、带密码 URL、Authorization header 和赋值形式 token。
- 覆盖普通密码学词汇、项目路径和正常代码，避免明显误报。
- 验证原文不出现在 finding、异常、审计和拒绝原因中。
- 验证多行、重复秘密、Unicode、长输入与扫描预算。
- 验证任何 LLM 输入和持久化入口都调用同一安全策略。

## Boundaries

- Always：先扫描再外发/落盘；模型输出再次扫描；无法安全处理时跳过候选。
- Ask first：新增外部扫描服务或扩大自动采集来源。
- Never：声称能识别任意密码/PII；保存秘密隔离区；读取 `.env`、私钥或凭据文件作为自动记忆来源。

## Success Criteria

- 高置信秘密以 `[REDACTED:<kind>]` 替代，私钥块等不可安全局部处理的内容被拒绝。
- 自动蒸馏仅接受 Session 来源，显式记住也不能绕过扫描。
- 注入文本包含不可信参考数据和按天数计算的时效提醒。
- 测试不将样例秘密写入真实 snail_memory。

## Open Questions

无阻塞项。首版不承诺通用 PII 检测；UI 明确安全边界。
