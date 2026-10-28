# Spec: memory-web

> 2026-10-27 修订：两个独立 enable 按钮已替换为关闭/workspace/global 三态单选和当前层 refresh；全局页展示所有 workspace 聚合条目且只读，删除在具体 workspace 页执行。以 `SPEC-global-aggregate-memory.md` 为当前契约。
>
> 2026-10-28 修订：workspace 下拉框支持选择任意已注册项目并直接切换召回范围；Ungrouped 不再禁用该选择，Host 的 `selectedWorkspaceId` 是恢复依据。

## Objective

在独立 Client bundle 中实现 Composer 全局/workspace 记忆控件和左侧 Memory 页面。所有持久状态来自 Host RPC，页面 reload、Host 重启和另一浏览器不得依赖 localStorage 恢复权威状态。

## Tech Stack

React、TypeScript、浏览器 fetch、Cordis slots、esbuild handoff bundle、Vitest/jsdom/Testing Library。无需修改 dsh Client 源码。

## Commands

```sh
npm run test -- tests/client
npm run typecheck
npm run build
npm run lint
```

## Project Structure

```text
client/src/entry.tsx          → slots 注册与卸载
client/src/rpc.ts             → 类型化同源 RPC
client/src/store.ts           → 查询、focus/change 刷新、stale response 防护
client/src/ComposerMemory.tsx → 两层 enable/refresh
client/src/MemoryPage.tsx     → sidebar main、双 tab、统计、详情、删除
client/src/icons.tsx          → 本地 SVG 图标
client/src/locale.ts          → 中英文 typed copy
client/src/styles.ts          → 注入样式
tests/client/                 → 组件、RPC、恢复和交互测试
scripts/build-client.mjs      → 单文件 window.__ModuleLoader__ handoff
```

## UI Contract

- `conversation.input.left` 注册一组紧凑控件，按 sessionId 获取状态；只有 Host 返回 enabled 且 workspace 选择与 Host 一致时才显示已启用。
- Composer 提供关闭/workspace/global 三态选择和当前层 refresh；已启用按钮再次点击可 disable。queued/refreshing/error 均有可见反馈。
- workspace 下拉框列出全部已注册项目，默认恢复 Host 的 `selectedWorkspaceId`，其次使用 Session owner，再其次使用首个注册项目。可选择非当前项目，Ungrouped Session 也可选择；已启用 A 时选择 B 会显示 Enable，并可直接切换召回项目。
- enable(workspace) 将下拉选择发送给 Host；重复启用同一项目保持幂等，refresh 只刷新 Host 当前已启用的召回 scope。旧 Session 或旧选择的异步响应不得覆盖新状态。
- `sidebar.panellist` 注册 Memory icon，`main` 使用相同 key 注册页面。
- 页面 tab 为“总记忆索引”和“当前 workspace 索引”；展示有效条目数、最近快照和当前 Session 累计注入估算 token。
- 条目可查看摘要、分类、更新时间和详情；删除需确认，成功文案明确“未删除对话历史，已注入快照仍保留”。
- 全局 tab 展示聚合条目及来源 workspace；无当前 workspace 时第二个 tab 显示空状态。
- token 一律标为“估算”，不得显示为 provider 精确 usage。

## Code Style

```tsx
export function MemoryLayerButton(props: {
  readonly enabled: boolean
  readonly busy: boolean
  readonly onEnable: () => void
}) {
  return <button disabled={props.enabled || props.busy} onClick={props.onEnable} />
}
```

React 和 dsh 包全部 external；不打包第二份 React。所有异步更新处理卸载和 stale session，操作后刷新 Host 状态并发送插件内 change 通知。

## Testing Strategy

- 新会话默认 disabled；重复 enable 同一选择不造成重复快照，已启用按钮可 disable。
- workspace 下拉框可选择非当前项目并传递其 id；A→B 直接切换、Ungrouped 选择和注册表加载失败均有明确行为。
- refresh 只在 enabled 后可用，同 revision 结果显示“已是最新”。
- reload 时 RPC 状态覆盖空白本地状态并恢复召回选择；旧 session 响应不得覆盖新 session。
- 双 tab、条目数、token 文案、workspace 空状态、详情和删除确认。
- sidebar/main key 一致，Composer 和页面卸载后清理 listener/timer。
- handoff 产物检查 external React、插件 id 和无裸 import。

## Boundaries

- Always：Host 权威状态；typed locale；可访问按钮和确认；仅插件 slots。
- Ask first：修改宿主 shell、增加全局设置页或第三方 UI 依赖。
- Never：修改 dsh 源码；用 localStorage 作唯一事实源；删除 Session；把估算 token 当精确值。

## Success Criteria

- 安装插件后 Composer 和左侧 Memory icon 均出现，无需手改宿主。
- 所有指定操作可用且 reload/restart 后开关与召回项目一致；非当前项目和 Ungrouped 选择均可启用。
- Memory 页两个 tab、统计、详情和删除完整可用。
- 390px 移动宽度无页面级横向溢出，按钮具有可访问名称。
- Client 测试、typecheck 和 handoff build 通过。

## Open Questions

无阻塞项。宿主在尚无 sessionId 的冷启动输入框不渲染 left slot，本插件不为此修改 shell；已创建的空白 Session 必须显示控件。
