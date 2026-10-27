# Snail Memory 实现计划

## 交付形态

独立 `dsh-snail-memory` npm/bundle 插件，包含 Host 与 Client half、`dsh.plugin.json`、`cordis.patch.yml`、构建和测试。目标 dsh 为 `0.2.1-rc.3`。不得修改 `deepseek-harness` 或 `dsh-prime-memory` 源码；参考插件只提供打包、slots 和自有 RPC 的装载先例。

## 垂直切片与检查点

1. **插件骨架 + memory-store + memory-safety**
   - 建立严格 TypeScript、构建、测试和 bundle 清单。
   - 实现 Temp 可测的 JSON 权威状态、锁/fencing、Markdown 投影、会话状态和扫描器。
   - 检查点：CRUD、重启、忘记、锁和脱敏测试通过。

2. **memory-context**
   - 实现两个 enable latch、快照、agent.inject、commit 对账、refresh 和详情工具。
   - 检查点：append-only、重启恢复、同 revision no-op、token 统计测试通过。

3. **memory-lifecycle**
   - 实现有效轮计数、idle 蒸馏、辅助 LLM、6 小时 dirty 整合和每日清理。
   - 检查点：触发边界、冷却、失败重试、无 Ungrouped 自动写入测试通过。

4. **memory-api**
   - 实现同源 RPC、输入校验、状态/统计端点和 `/memory` 命令。
   - 检查点：路由白名单、只读错误、删除不影响 Session 的测试通过。

5. **memory-web**
   - 实现 Composer、sidebar/main、双 tab、详情、统计、删除和中英文文案。
   - 检查点：Client 交互、 stale response、恢复和 handoff bundle 测试通过。

6. **独立安装与整体验证**
   - 构建 tarball，在隔离 DSH_HOME/profile 安装并检查 dump-config，不擅自重启用户正在运行的 Host。
   - 运行 `npm test`、`npm run typecheck`、`npm run lint`、`npm run build` 和可用的 Web 冒烟。
   - 核对 dsh 与参考插件 `git status`，确认没有源码修改。

## 依赖与并行

store 和 safety 无内部依赖，可并行；context 和 lifecycle 在两者完成后并行；api 依赖三个 Host 能力；web 只依赖 contract 和 RPC，可在 api 契约固定后与 Host 生命周期并行；最终验证最后执行。

## 风险与处理

- **树外 Remote 不可注册**：使用插件自有 `webServer.register` 同源 RPC，不改 allowlist。
- **inject 无持久 ACK**：区分 desired/queued/committed，使用 Session 提交事件对账。
- **多 Host 写冲突**：root 写锁、heartbeat 和 fencing；第二 Host 只读。
- **遗忘与审计冲突**：审计不存正文，权威快照原子移除条目，Markdown 详情删除。
- **辅助模型不可用**：显式错误并保留 dirty，不用空输出伪造整合成功。
- **宿主 slots 差异**：按 0.2.1-rc.3 目标版本注册并在缺失时响亮告警，不修改宿主。

## 完成定义

六份 Spec 的可测试 Success Criteria 均满足；所有数据默认位于 `~/.dsh/snail_memory`；安装无需修改 dsh；Web 所有请求功能可用；测试和构建真实通过；未完成的真实 Host/UI 验证必须明确列出，不得宣称已验证。
