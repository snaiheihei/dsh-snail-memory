# Spec: memory-api

## Objective

提供树外插件自有的 Host 服务与同源 HTTP RPC，以及 `/memory` 人类命令。API 组合 store/lifecycle/context，不修改 dsh Remote 注册表或任何产品源码。

## Tech Stack

TypeScript、Cordis、`webServer.register()`、浏览器 fetch 对应 JSON 契约、Cordis commands、Vitest。

## Commands

```sh
npm run test -- tests/api
npm run typecheck
npm run build
npm run lint
```

## Project Structure

```text
src/contract.ts          → Client/Host 共享请求、响应和错误类型
src/api/validate.ts      → RPC 边界运行时校验
src/api/http.ts          → POST /snail-memory/rpc/<method> 白名单
src/api/controller.ts    → 服务组合、错误映射、变化通知
src/api/command.ts       → /memory remember|correct|forget|status
src/api/index.ts         → 注册与卸载
client/src/rpc.ts        → 同源 fetch、传输/业务错误分离
tests/api/               → 路由、校验、错误和命令测试
```

## RPC Surface

- `getSessionState(sessionId)`：返回两层 latch、desired/committed revision、最近/累计估算 token、workspace 和 queued 状态。
- `enable(sessionId, layer)`、`refresh(sessionId, layer)`：单向开关与追加快照。
- `list(scope, sessionId?)`：返回有效索引条目、全局 workspace 引用、条目数和存储只读状态。
- `read(scope, id)`、`remove(scope, id)`：UI 父记忆完整详情与删除；remove 等价忘记，不接受 Session 参数。大详情分片只约束模型工具读取，不改变管理 UI 的人类详情查看契约。
- `remember(input)`、`correct(input)`：显式立即写入；scope 由调用者明确给出。
- `status()`：writer/read-only、dirty、下次整合/清理时间、最近脱敏错误的安全描述。

所有端点仅接受 POST JSON 和白名单短方法名；限制 body 大小，校验 content-type、自定义请求头、id 枚举和字符串长度。错误分业务 `ok:false` 与传输失败，不返回堆栈或秘密。

## Code Style

```ts
export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

const routes = { getSessionState, enable, refresh, list, read, remove } as const
```

命令与 RPC 调用同一服务方法，不复制业务逻辑。注册和注销均走 Cordis effect。

## Testing Strategy

- 非白名单方法、GET、错误 content-type、大 body、无效 id、未知 workspace。
- 只读 Host 写操作明确失败，读操作仍可用。
- enable/remove 等幂等与错误响应，不包含内部路径或正文。
- `/memory` 子命令语法、目标 scope、即时写入与状态输出。
- 卸载后路由和命令不再可用。

## Boundaries

- Always：同源 JSON、显式参数校验、结构化错误、复用服务层。
- Ask first：新增非本机鉴权暴露、远程网络访问或新写端点。
- Never：修改 dsh `api/remotes`；提供任意文件 RPC；接受删除 Session 的请求。

## Success Criteria

- Client 全部功能可仅通过插件自有 RPC 完成。
- 无效输入在进入业务层之前被拒绝。
- 删除 API 只能删除记忆，不存在 Session 删除代码路径。
- 插件安装后 bundle 自动挂载，无需手改 profile 或 dsh 源码。

## Open Questions

无阻塞项。首版依赖 dsh Web Host 现有同源访问控制，不另开监听端口或独立认证服务。
