# Spec: memory-web

> 2026-10-29 rank 反馈修订：Memory 页列表和详情展示 rank；列表在 Client 复制索引后按 rank、内容 updatedAt、id 排序，不修改 Host 数组，也不改变 Store 或模型快照的注入顺序。
>
> 2026-10-28 独立 Global 修订：Global tab 只显示人工 Promote 的独立条目并允许删除；workspace 详情弹窗增加 Promote，Settings 增加默认 7 天的 Global consolidation delay。全局不再显示 workspace 聚合条目和引用。
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
client/src/MemoryPage.tsx     → sidebar main、Global/Workspaces/Settings 三 tab、统计、详情、Promote、删除与设置
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
- 页面 tab 为“全局记忆索引”、“Workspaces”和“Settings”；展示有效条目数、最近快照和当前 Session 累计注入估算 token。
- 条目列表与详情展示整数 rank。列表先复制 Host 返回的索引，再按 rank 降序、内容 `updatedAt` 降序、id 升序稳定排序；不得原地修改 RPC 数组。该排序只影响人类管理界面，不改变 `store.list()`、快照渲染或注入顺序。
- 条目可查看摘要、分类、更新时间和详情；workspace 详情提供 Promote，Global 与 workspace 均允许删除且需确认。删除成功文案明确“未删除对话历史，已注入快照仍保留”；Promote 成功/已存在反馈不暗示后续自动同步。
- 全局 tab 只展示独立 Global 条目，不显示来源 workspace 聚合列表；Settings 提供默认 7 天的 Global consolidation delay，与 workspace 20 小时设置分开保存。
- 无当前 Session owner workspace 时，Workspaces tab 仍可从完整注册表选择任意已注册项目并读取索引；只有没有可用注册项目或注册表加载失败时显示相应空态/错误。Ungrouped 不因此获得隐式写入 owner，Global tab 始终可独立使用。
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
- Global/Workspaces/Settings 三 tab、条目数、token 文案、无 owner 时的注册项目选择、详情、Promote、删除确认和设置保存。
- Host 返回顺序与 UI 顺序不同时，验证 rank 降序、同 rank 的 updatedAt 降序和 id 稳定顺序；Host 原数组保持不变，列表与详情均显示 rank。
- sidebar/main key 一致，Composer 和页面卸载后清理 listener/timer。
- handoff 产物检查 external React、插件 id 和无裸 import。

## Boundaries

- Always：Host 权威状态；typed locale；可访问按钮和确认；仅插件 slots。
- Ask first：修改宿主 shell、增加全局设置页或第三方 UI 依赖。
- Never：修改 dsh 源码；用 localStorage 作唯一事实源；删除 Session；把估算 token 当精确值。

## Success Criteria

- 安装插件后 Composer 和左侧 Memory icon 均出现，无需手改宿主。
- 所有指定操作可用且 reload/restart 后开关与召回项目一致；非当前项目和 Ungrouped 选择均可启用。
- Memory 页 Global/Workspaces/Settings 三 tab、统计、详情、Promote、删除和设置保存完整可用。
- 列表和详情显示 rank，UI 排序符合 rank/updatedAt/id 契约且不修改 Host 数据；Store 与快照顺序不受影响。
- 390px 移动宽度无页面级横向溢出，按钮具有可访问名称。
- Client 测试、typecheck 和 handoff build 通过。

## Open Questions

无阻塞项。宿主在尚无 sessionId 的冷启动输入框不渲染 left slot，本插件不为此修改 shell；已创建的空白 Session 必须显示控件。
