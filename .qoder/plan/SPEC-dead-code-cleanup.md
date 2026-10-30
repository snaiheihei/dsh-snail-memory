# SPEC-dead-code-cleanup：删除已核实的零行为变化死代码

## 1. 需求与场景

- 用户 / 调用方：插件维护者；Host、Client 与现有测试继续使用既有真实接口。
- 触发方式与频次：一次性、小批量内部清理，不随运行触发。
- 规模：单仓库 TypeScript 插件；沿用现有单 Host 运行方式，不引入新执行体。
- 生命周期与维护者：插件持续维护，本批只降低阅读成本。
- 明确不做（Non-goals）：不改 RPC 形状或鉴权；不改 scheduler/retention/consolidation 元数据所有权；不删写锁、持久 intent、重试、串行队列、注入对账、活动日志或 stale-response 防护；不做依赖/lockfile 清理；不删除旧 maintenance 通路、`reviewCount`、`onPrompt` 或公开兼容字段；不创建提交。

## 2. 复杂度预算（超出即停下重新批准）

| 项 | 预算 | 实际 | 超支理由 |
|---|---|---|---|
| 新增文件 | ≤ 1（仅本 spec） | 1 | |
| 修改既有文件 | ≤ 16 | 15 | |
| 新增依赖 | 0 | 0 | |
| 新增对外接口/导出 | 0 | 0 | |
| 预估变更 | ≤ 160 行，源码净减少 ≥ 45 行 | 165 行，源码净减少 70 行 | 测试直调迁移比预估多 5 行；未增加文件、机制或范围 |

## 3. 6 问结论

| # | 问题 | 回答与来源 | 由此决定 |
|---|---|---|---|
| Q1 | 使用场景、规模与部署 | 沿用现有单 Host 单进程部署，不新增执行体 [默认·假设A1] | 不引入并发、外部状态或新抽象 |
| Q2 | 生命周期与维护 | 插件持续维护，本批只做可读性清理 [默认·假设A2] | 保留现有测试行为，迁移测试而非删覆盖 |
| Q3 | 共享状态与不变量 | 不新增共享可变状态，既有锁与事务不变 [用户] | 不加锁、不改事务，不删除可靠性机制 |
| Q4 | 外部失败策略 | 重试、失败与资源清理语义全部不变 [用户] | 不碰重试、队列、补偿和错误映射 |
| Q5 | 性能测量与目标 | 无性能问题或优化目标 [用户] | 不做缓存、结构优化或性能重写 |
| Q6 | 变化点与抽象边界 | 不预设新变化点，只删已证实冗余 [用户] | 不新增接口、包装层或配置 |

## 4. 方案与步骤

1. 清理 Context/Host：删除只写不读的 `queued`、对应 discarded handler/订阅；删除 `getSessionState()` 测试包装并把测试改为读取现有 `store`。验证 `tests/context`、`tests/host`。
2. 清理内部 helper/export：删除无调用的 snapshot/transcript/lifecycle barrel/LLM alias/consolidate wrapper，删除未读取的 `SnapshotInput.scope`；transcript 测试改用 `nextDistillationBatch()`，`emptyState` 测试改从 canonical `store/json.ts` 导入。验证相关 context、host、lifecycle 测试。
3. 清理 Client/API/Host 冗余：内联 `notifyChanged()` 的四处调用，删除单用 command result alias、controller 再导出和四个被 settings 覆盖的静态 lifecycle spreads；保留 `retentionSweepHours`。验证 client、api、host 测试。
4. 做只读减法复核并运行全量 test、typecheck、lint、build、`git diff --check`；回填 §9。

## 5. 依赖与新增文件（每个一行理由）

| 名称 | 类型 | 为什么必须有 | 没有它怎么办 |
|---|---|---|---|
| `SPEC-dead-code-cleanup.md` | 计划文档 | 记录跨模块删除边界、预算与验证结果 | 无运行时替代；不新增其他文件 |

## 6. 设计项台账（核心）

| 设计项 | 它解决什么场景 | 当前消费者数 | 当前是否必需 | 推迟的触发条件 | 删除会坏什么 |
|---|---|---|---|---|---|
| Context `queued` 及 discarded 通路 | 无；集合从未参与判断 | 0 个读取者 | 删除 | 不适用 | 无；保留 `queueKey()` 的 Session 对账用途 |
| Context `getSessionState()` | 测试读取状态 | 仅测试 | 删除 | 不适用 | 测试改用既有 `store.getSessionState()`，覆盖不变 |
| `renderSnapshot()` | 无生产调用 | 0 | 删除 | 不适用 | 无；生产继续使用 `renderSnapshotWithIds()` |
| `SnapshotInput.scope` | 无；渲染从未读取 | 1 个传参者、0 个读取者 | 删除 | 不适用 | 删除对应传参，输出不变 |
| `renderSessionTranscript()` | 测试渲染完整转录 | 仅测试 | 删除 | 不适用 | 测试改用真实分批入口，投影与游标逻辑保留 |
| `store.ts` 的 `emptyState` 再导出 | 一个测试导入 | 1 个测试 | 删除 | 不适用 | 测试改从 `store/json.ts` 导入 |
| `lifecycle/index.ts` barrel | 无仓库导入、非 package export | 0 | 删除 | 不适用 | 无 |
| `LlmModel` alias | 无引用 | 0 | 删除 | 不适用 | 无；`AuxiliaryModel` 保留 |
| Lifecycle `consolidate()` | 无调用；控制器使用 `consolidateNow()` | 0 | 删除 | 不适用 | 无；手动 Scheduler 通路保留 |
| Client `notifyChanged()` | 四个内部纯转发调用 | 4 个内部调用 | 删除 | 不适用 | 调用直接 `refreshActive()`，刷新顺序不变 |
| `MemoryCommandResult` | 单个返回类型别名 | 1 个自身使用 | 删除 | 不适用 | 返回既有 `CommandResult` |
| Controller `workspaceId` 再导出 | 无消费者 | 0 | 删除 | 不适用 | canonical `store/types.ts` 导出保留 |
| 四个静态 lifecycle spreads | settings 已提供并优先使用相同值 | 0 个有效消费者 | 删除 | 不适用 | 有效配置解析不变；保留独立 retention sweep 配置 |

## 7. 假设与风险

| ID | 假设内容 | 来源(Q#) | 若错，代价（具体到要重做哪部分） | 何时能发现 |
|---|---|---|---|---|
| A1 | 当前仍只需支持既有单 Host 单进程语义，没有依赖 discarded 事件做跨实例协调的消费者 | Q1 | 重新评估并恢复约 20 行 discarded/queued 通路及 Host 订阅 | Host 注入/卸载测试与真实多 Host 场景 |
| A2 | 这些内部模块没有仓库外源码消费者；支持契约仅限 `package.json` exports | Q2 | 若存在树外深路径源码导入，需恢复对应内部导出或提供兼容版本，单项约 1–15 行 | package 导出审查、typecheck/build 与下游反馈 |

## 8. 决策记录（人类反馈回写，只追加）

| 时间 | 问题 | 人类裁决 | 对设计的影响 |
|---|---|---|---|
| 2026-10-30 | 是否再做一批零行为变化死代码清理 | 用户明确 | 只实施已核实候选，不改 RPC、调度架构或核心可靠性机制，不提交 |

## 9. 实际结果（实现后回填）

- 计划 vs 实际：新增 1 个 spec，修改 15 个既有文件，新增依赖与对外导出均为 0。总计 48 行新增、117 行删除，净减少 69 行；其中源码/Client 净减少 70 行，测试因 canonical import 净增加 1 行。165 行变更比预估多 5 行，全部来自既定测试迁移，未扩大范围。
- 删除清单：无效 `queued` 与 discarded 通路、Context 状态包装、未读取的 snapshot scope、两个无生产调用的渲染包装、lifecycle barrel、`emptyState`/`workspaceId` 再导出、`LlmModel`、`MemoryCommandResult`、Lifecycle `consolidate()`、Client `notifyChanged()`、四个被 settings 覆盖的启动 spreads，以及两个陈旧 dist barrel 产物。
- 保留清单及理由：`queueKey()` 仍服务 Session committed 对账；`renderSnapshotWithIds()` 与 `nextDistillationBatch()` 是真实生产入口；`consolidateNow()` 是 Scheduler 手动整合入口；`retentionSweepHours` 不经 settings 提供，必须独立转发。旧 maintenance 通路、`reviewCount`、`onPrompt`、RPC/aggregate 字段和依赖清理继续推迟，避免扩大兼容与验证范围。
- 公开接口：`package.json` 的 root/client/contract exports、RPC 请求响应、持久化 schema 与 CLI 行为均未改变；删除项均为非 package export 的内部深路径导出。
- 验证：Context/Host 41 项、扩大相关测试 103 项、Client/API/Host 87 项均通过；全量 32 个文件 273 项测试通过；typecheck、lint、build、`git diff --check` 通过；`npm pack --dry-run` 通过，最终 81 个文件且不含陈旧 lifecycle barrel。
