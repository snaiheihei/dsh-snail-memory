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

### 条目 rank 与 committed 使用反馈增量（2026-10-29）

- 父条目新增默认 0 的整数 rank，旧 v2 状态缺失或非法时恢复 0；内容纠正保留已有 ID 的 rank，Promote 新 Global 副本从 0 开始，consolidation 保留目标 rank、不相加被取代条目。
- desired/committed injection 保存 token 预算内实际渲染的 memoryIds；新增 `snail_memory_feedback`，仅接受 layer、memory_id 和 helpful/unhelpful/incorrect，由 Host 推导 Session 与召回 scope。反馈结果只含稳定状态和可选 rank，不返回记忆正文。
- 只有 committed 快照实际包含的条目可反馈；同一 Session + injection + memory 通过持久回执跨重启幂等，新 committed injection 可再次反馈。Store 专用事务同时完成资格校验、rank ±1 和回执写入，不修改内容、条目/scope revision、内容时间、dirty、调度、游标或快照。
- read 与 feedback 工具结果均从后续蒸馏投影排除，普通工具结果保留。Web 列表与详情显示 rank，Client 复制索引后按 rank、内容 updatedAt、id 排序；Store 与快照仍按 updatedAt/id，避免高分自我强化。
- 已同步 memory-store/context/lifecycle/safety/web Spec、能力地图和记忆演化文档。最终全量自动化为 31 个测试文件、242 项测试全部通过，typecheck、lint、build 和 `git diff --check` 通过；首次全量运行有一个既有跨 workspace refresh 用例在并行 I/O 负载下达到 5 秒超时，隔离运行 448ms 通过，未改代码后完整复验全部通过。
- 本轮未执行真实 Host/UI/模型验收，未安装到真实 Host、重启用户进程或创建 git commit。

### 生命周期活动调度日志增量（2026-10-29）

- 新增插件自有、非权威的 append-only `logs/lifecycle.v1.jsonl`，与 `state.v2.json` 和事务 `audit.v1.jsonl` 分离；activity 追踪生命周期任务的建立与运行，audit 仍只回答存储事务是否提交。
- Review、Idle、Stop、workspace/Global consolidation 和 retention 统一由 Scheduler 记录 `intent-created`、`run-started`、`batch-completed`、`run-succeeded`、`run-skipped`、`run-failed`、`retry-scheduled`；同一 intent ID 关联单次运行，重试记录新 retryIntentId 和实际到期时间。
- 记录字段限为时间、操作、Session/workspace、耗时、批次、written/rejected、游标位置、processed/hasMore、跳过原因、稳定错误分类和重试元数据；不写对话、prompt、summary/detail、模型原始响应、异常原文或秘密。idle debounce 只在首次建立持久 intent 时记录，不为每次活动刷新刷日志。
- `run-succeeded` 在业务运行和权威调度状态收尾后记录；无 owner、无新事件和 clean workspace 分别记录 `workspace-unassigned`、`no-new-events`、`workspace-clean`。保留 `runIntent() → { written }` 兼容接口，详细结构化结果供调度日志使用。
- 文件 sink 使用串行 Promise 队列，默认单文件 1 MiB，保留当前文件加最多 `.1`、`.2`、`.3` 三个历史代际；写入 best-effort，日志故障不改变记忆任务结果，Scheduler dispose 先 flush，插件卸载最后 close。首版不提供 UI 或 RPC。
- 差异复核发现 idle debounce 每次刷新曾更换 intent ID，导致唯一一条 intent-created 无法与实际运行记录串联；新增同一 ID 断言先复现失败，再让同代 idle 刷新保留原 ID，最终 created/started/succeeded 可完整关联。
- 聚焦自动化已实际通过 5 个测试文件、65 项测试；最终全量自动化为 32 个测试文件、254 项测试全部通过，typecheck、lint、build 和 `git diff --check` 通过；变更范围高置信私钥、云密钥、令牌与 Bearer 模式扫描无命中。本轮未执行真实 Host/UI/模型验收，未安装到真实 Host、重启用户进程或创建 git commit。

### 手动 scope 整合增量（2026-10-29）

- Global 与 Workspaces tab 分别提供当前独立 Global、当前下拉选择 workspace 的手动整合入口；点击后先确认可能合并、纠正和取代记忆但不会修改对话历史，执行中显示 busy，成功展示真实 `written`，失败展示稳定错误。
- 手动请求复用 Scheduler 的 `consolidate:<workspaceId>` / `global-consolidate` 持久 intent、单 timer、串行队列、重试和活动日志；clean scope 也可显式执行。RPC 不直接调用 `consolidateMemories()`，Host 按 scope 共享等待 Promise，重复手动请求防重，并可加入正在运行的自动整合而不重复执行或重排其计划。
- 调用方等待目标 intent 的真实结果而非 `drain()` 整个队列；成功在权威调度状态收尾后返回，失败在重试状态持久化后拒绝，Scheduler 停止会拒绝未完成的进程内等待者，避免 RPC 永久等待。
- 新增白名单 `consolidate` RPC、ScopeRequest 校验和已注册 workspace 校验；Client 成功后刷新跟踪索引。UI 以请求代际防止旧 tab、Session 或 workspace 的响应覆盖新选择，切换视图不取消 Host 已接受的维护任务。
- 手动整合不跨 scope、不自动 Promote，不读取或修改 Session、对话历史及蒸馏游标，不绕过秘密扫描、来源汇集和 revision 检查，也不自动追加新快照；仍由既有 enable/refresh 规则控制后续注入。
- 已同步 lifecycle/API/Web Spec、能力地图和记忆演化文档。聚焦自动化实际通过 4 个测试文件、65 项测试；最终全量自动化为 32 个测试文件、263 项测试全部通过，typecheck、lint、build 和 `git diff --check` 通过。首次全量运行有一个既有 Store Promote 隔离用例在并行 I/O 负载下达到 5 秒超时，隔离运行 540ms 通过，未改代码后完整复验全部通过。
- 最终差异复核未发现直接整合旁路或跨 scope 写入；高置信秘密模式扫描只命中既有合成安全测试样本，没有新增真实凭据。本轮未执行真实 Host/UI/模型验收，未安装到真实 Host、重启用户进程或创建 git commit。

## 后续修改 Plan（2026-10-28）

当前运行定案为单一 dsh Client、单 Host。以下事项明确后置，不属于本轮来源汇集、模型输出边界、安全扫描和 Scheduler intent 代际修复：

1. **Store expected-revision 条件写**：未来在 consolidate、distill、retention 和 correct 需要的写路径中，把 revision 校验与 upsert/remove 纳入同一原子事务，进一步关闭慢模型期间的旧快照写回窗口。
2. **Store 未显式修改元数据的保留**：未来让更新路径保留调用方未显式修改的附加元数据，并覆盖 consolidate、distill、retention 和 correct 的回归测试；本轮不改变现有元数据更新语义。
3. **完整跨 Host writer 代际 fencing**：仅在将来决定支持多个 Host 共同访问同一存储根时实施，包括进行中事务的代际验权与原子条件发布；当前单 Host 方案不把它作为验收前提。
