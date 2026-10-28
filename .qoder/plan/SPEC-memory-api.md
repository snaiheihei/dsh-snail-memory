# Spec: memory-api

> 2026-10-28 独立 Global 修订：新增 Promote RPC；Global read/remove 接受独立 global scope，remember/correct 仍只允许 workspace。Global 列表不再聚合 workspace。

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

- `getSessionState(sessionId)`：返回 `SessionStateView`，包含 Session owner `workspaceId`、独立召回选择 `selectedWorkspaceId`，以及两层各自的 `enabled`、最新 desired/committed revision、active pending 数、最近和累计已提交估算 token；不返回完整 desired/committed 正文。
- `enable(sessionId, layer, workspaceId?)`：启用 Global 或指定已注册 workspace，返回 `MemoryOperationResult`；重复启用相同选择幂等，切换层或项目会建立新的唯一 active desired。workspace 参数只改变召回选择，不改变 Session 写入 owner。
- `disable(sessionId)`：关闭两层并清除 active desired；`refresh(sessionId, layer)` 仅在当前已启用 scope revision 前进时创建新快照代，否则返回 up-to-date。
- `list(scope)`：返回 `MemoryIndex = { scope, revision, entries, workspaces }`；条目数由 `entries.length` 派生，只读状态由 `status()` 单独获取。Global 只返回独立条目，当前 `workspaces` 聚合引用数组为空。
- `read(scope, id)`、`remove(scope, id)`：UI 父记忆完整详情与删除；read 异步按需读取目标版本化详情记录，remove 返回 `{ removed }`，等价忘记且不接受 Session 参数。Global remove 只删除独立 Global 副本。remove 不读取、回退、重置或推进任何 Session `distillationCursor`，也不会使已处理历史重新蒸馏或恢复已删条目。大详情分片只约束模型工具读取，存储懒加载和分片都不改变管理 UI 的人类完整详情查看契约。
- `promote(scope, id)`：从已注册 workspace 的源条目深复制到独立 Global，返回 `{ id, created }`；重复 Promote 幂等，不接受 global 来源。
- `remember(input)`、`correct(input)`：显式立即写入；输入包含 workspace scope、category、summary、detail 和可选 source sessionId，correct 另含 id。直接 Global 写入不可用，Global 人工副本只能经 Promote 建立。
- `status()`：返回 `MemoryStatus`，包含 writer/read-only、workspace/Global dirty、各自下次及最近整合、下次及最近 retention、pending intent 和最近稳定错误类别。
- `getSettings()`、`updateSettings(settings)`：读取或完整保存 Review/Idle、两类 consolidation、共享快照 token 预算和五类 retention 设置；update 返回持久化后的设置。
- `listWorkspaces()`：返回已注册项目的 `{ id, title }` 数组，供 Composer 和 Memory 页选择召回及管理范围。

所有端点仅接受 POST JSON 和白名单短方法名；限制 body 大小，校验 content-type、自定义请求头、id 枚举和字符串长度。错误分业务 `ok:false` 与传输失败，不返回堆栈或秘密。

## Code Style

```ts
export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

const routes = {
  getSessionState, enable, disable, refresh, list, read, remove, promote,
  remember, correct, status, getSettings, updateSettings, listWorkspaces,
} as const
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
