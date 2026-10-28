# Snail Memory 实现计划

## 交付形态

独立 `dsh-snail-memory` npm/bundle 插件，包含 Host 与 Client half、`dsh.plugin.json`、`cordis.patch.yml`、构建和测试。目标 dsh 为 `0.2.1-rc.3`。不得修改 `deepseek-harness` 或 `dsh-prime-memory` 源码；参考插件只提供打包、slots 和自有 RPC 的装载先例。

## 垂直切片与检查点

1. **插件骨架 + memory-store + memory-safety**
   - 建立严格 TypeScript、构建、测试和 bundle 清单。
   - 实现 Temp 可测的 JSON 权威状态、锁/fencing、Markdown 投影、会话状态和扫描器。
   - 检查点：CRUD、重启、忘记、锁和脱敏测试通过。

2. **memory-context**
   - 实现关闭/workspace/global 三态单选、单 active desired、快照、agent.inject、commit 对账、跨 workspace enable/refresh 和详情工具。
   - 检查点：append-only、重启恢复、同 revision no-op、disable 撤回和 token 统计测试通过。

3. **memory-lifecycle**
   - 实现有效轮计数、Review/Idle/Stop 顺序蒸馏、辅助 LLM、workspace 默认 20 小时与独立 Global 默认 7 天 dirty 整合，以及仅 workspace 的每日清理。
   - 检查点：触发边界、持久游标、两类冷却、失败重试、无 Ungrouped 隐式写入测试通过。

4. **memory-api**
   - 实现同源 RPC、输入校验、状态/统计端点和 `/memory` 命令。
   - 检查点：路由白名单、只读错误、删除不影响 Session 的测试通过。

5. **memory-web**
   - 实现 Composer 三态控件、sidebar/main、Global/Workspaces/Settings 三 tab、跨项目管理、详情、统计、Promote、删除和中英文文案。
   - 检查点：Client 交互、stale response、Host 状态恢复和 handoff bundle 测试通过。

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

## 实施与验证记录（2026-10-27）

### 完成状态

- 六个垂直切片均已实现；插件源码、Host/Client bundle、Spec、测试和构建脚本已纳入 Git，基线提交为 `437a60a`（`feat: implement Snail Memory plugin`）。
- 目标 `deepseek-harness` 保持 `0.2.1-rc.3`，通过树外 tarball 和 `dsh plugin --profile web add` 安装；未修改 dsh 或 `dsh-prime-memory` 源码。
- 自动化验证已实际通过：25 个测试文件、103 项测试，以及 typecheck、lint、build。tarball 安装和组合配置检查通过。

### 真实模型端到端验证

- 使用独立 `$DSH_HOME`、独立 47895 端口和用户提供的 credentials-local 文件，不复制、打印或提交凭据。为缩短测试，仅在隔离配置中设置 `reviewEveryUserTurns: 1`、`idleDelayMinutes: 0`、`consolidationCooldownHours: 0`；产品默认值未改。
- 小米目录中的 `mimo-v2.5` 和 `mimo-v2.5-pro` 均由真实 API 返回 `Unsupported model`；改用 `mimo-v2.6-flash` 后，普通对话成功并精确返回 `E2E_MODEL_OK`。
- 真实辅助模型完成会话蒸馏，写入 2 条 workspace 记忆，workspace scope revision 从 0 前进到 2；两条记忆均保留来源 Session 的 `sourceRefs`，详情和 Markdown 投影可读。
- 真实整合随后完成：`lastConsolidationAt` 已写入，`pending` 清空，`dirty` 为 false，`lastError` 为 null。
- global 与 workspace 两层逐层 enable 后各生成一次快照；下一次真实提问精确返回 `E2E_MEMORY_OK`，两层快照均由 post-commit 事件转为 committed。workspace 注入为 revision 2，global 仅含 workspace 索引引用。
- Web Memory 管理页实际显示 2 条 workspace 条目、312 个估算注入 tokens、revision 2、分类、来源、详情和删除入口；global tab 显示 0 条全局正文及对应 workspace 引用。
- 对测试存储执行高置信密钥、Bearer 和凭据路径扫描，无命中；audit 未出现 summary、detail、snapshot 或 sourceRefs 正文。
- 配置热重载和多实例竞争期间观察到第二实例按设计进入只读；最终验证在写锁恢复且 `writable: true` 的干净 Host 中完成。

### 保留边界

- 本轮未补做移动视口 UI 验证，也未逐事件核对压缩 Session 的完整注入顺序；已验证正常 Session 的 desired/committed 对账和下一次提问后的提交结果。
- Composer 的 queued/committed 数字仍受既有 UI 新鲜度限制，可能需 reload 或重新打开管理页才显示最新 committed 状态；权威 `state.v1.json` 已确认两层 committed。
- 删除只影响记忆而不删除对话历史的交互已在先前无凭据 Web 冒烟中验证；本轮真实模型测试未删除这两条蒸馏证据。

### 大详情分片增量（2026-10-27）

- 已同步更新能力地图及 memory-store、memory-context、memory-api Spec：父 JSON 正文保持权威，详情大于 8,000 字符时确定性拆为至多 4,000 字符的无损分片。
- scope 主索引和核心摘要仍只保留父条目；大详情投影为 `details/<id>/INDEX.md` 与 `part-NNN.md`，小详情保持 `details/<id>.md`。纠正、缩片、形态切换和删除会清理陈旧投影。
- `snail_memory_read` 对大详情默认只返回有序分片清单及字符/token 估算；指定 `chunk_id` 仅返回目标单片。小详情、未启用层和未知 id 的兼容/拒绝行为均有测试。
- 分片功能未修改 enable、refresh revision、desired/committed 或 dsh Session 持久化逻辑；管理 RPC 仍提供人类查看用的父完整详情。
- 独立复核后补充四个回归边界：分片目录使用临时目录完整写入并切换，失败保留旧整套投影；删除清理纳入事务队列，避免同 ID 重建竞争；空 `chunk_id` 不再回退完整正文；小详情升级分片时先成功发布新目录再删除旧文件，写失败保留旧小详情。
- 已实际通过 28 个测试文件、114 项测试，以及 typecheck、lint、build。本轮未重新执行真实 Host/模型分片冒烟，也未向真实 Host 安装新构建。

### 父索引驻留与详情懒加载增量（2026-10-27）

- 权威状态升级为 `state.v2.json` 与 `detail-data/<id>/<revision>.json`：内存只驻留父索引、Session 和调度状态；list、enable、refresh 及保留期清理不读取完整详情，单条 read 按 id/revision 异步加载。
- 保留 v1 可写迁移和只读兼容读取；迁移先写详情记录与投影，再发布 v2，成功后才删除 v1。外部 RPC、Web 完整详情、工具分片读取和 Session 契约保持不变。
- 写事务使用只含父 id 的 `projection-pending.v1.json` 协调多文件发布：提交前失败恢复旧投影，提交后派生失败返回 committed 结果并留待重启或后续事务恢复；小详情和 INDEX/MEMORY 采用原子文本写入。
- writer 本地 read 与写入串行；第二 Host 在 read 前刷新父状态并在记录 ENOENT 时重试。补充父状态失败、索引失败重开恢复、只读 v1、跨 Host 纠正/删除和 read/remove 竞争回归测试。
- 已实际通过 28 个测试文件、124 项测试，以及 typecheck、lint、build 和 `git diff --check`。本轮未向真实 Host 安装新构建，也未重新执行真实 UI/模型 E2E；懒加载及恢复结论来自自动化与故障注入验证。
