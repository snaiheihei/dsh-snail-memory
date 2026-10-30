# SPEC-structural-refactors：收敛调度元数据并拆分 Writer 与 RPC contract

## 1. 需求与场景

- 用户 / 调用方：插件维护者；Host、Client、Scheduler 独立调用与 LifecycleService 直接调用均保持既有行为。
- 触发方式与频次：一次性、分三阶段的内部结构重构，不随运行触发。
- 规模：单仓库 TypeScript 插件；沿用单 Host 单进程与现有持久化串行队列。
- 生命周期与维护者：插件持续维护，本批降低重复策略与跨层契约维护成本。
- 明确不做（Non-goals）：不改 RPC wire shape、localhost 鉴权、持久化 schema、调度时间、重试/代际保护、公开运行时入口；不新增依赖；不安装或重启真实 Host；不创建提交。

## 2. 复杂度预算（超出即停下重新批准）

| 项 | 预算 | 实际 | 超支理由 |
|---|---|---|---|
| 新增文件 | ≤ 2（本 spec、`writer-runtime.ts`） | 2 | |
| 修改既有文件 | ≤ 10 | 10 | |
| 新增依赖 | 0 | 0 | |
| 新增运行时对外接口/导出 | 0；仅迁移既有类型声明 | 0 | |
| 预估变更 | ≤ 220 行， Scheduler 拆文件后净减少 ≥ 70 行 | 源码/测试 461 行，Scheduler 净减少 17 行 | Writer 机械移动与 RPC maps 迁移计入增删；Scheduler 同时承接 84 行共用 metadata 策略，未增加范围或机制 |

## 3. 6 问结论

| # | 问题 | 回答与来源 | 由此决定 |
|---|---|---|---|
| Q1 | 使用场景、规模与部署 | 沿用现有单 Host 单进程部署，不新增执行体 [默认·假设A1] | 不引入并发、外部状态或新调度层 |
| Q2 | 生命周期与维护 | 插件持续维护；内部深路径不作为额外兼容契约 [默认·假设A2] | 可移动内部类与类型，保留现有 Client 测试导入兼容 |
| Q3 | 共享状态与不变量 | 既有写锁、串行 queue、schedule snapshot、dirty 保留与 Idle generation 均不变 [用户] | 复用现有 Store 事务，不加锁、不改快照判断 |
| Q4 | 外部失败策略 | 既有持久 intent、重试时间、稳定错误和资源释放语义不变 [用户] |  Scheduler 与 Service 共用收尾策略，但不改失败通路 |
| Q5 | 性能测量与目标 | 无性能问题或优化目标 [用户] | 不做缓存、并行化或算法优化 |
| Q6 | 变化点与抽象边界 | 只处理用户指定的调度元数据、Writer 文件边界和 RPC 类型重复 [用户] | 不新增配置、依赖注入、事件层或通用抽象 |

## 4. 方案与步骤

1. **调度元数据收敛**：在 `LifecycleScheduler` 内提供整合成功/失败与 retention 成功的共用收尾方法。`MemoryLifecycleService` 的直接整合调用复用这些方法；`consolidate.ts` 只处理记忆整合，`retention.ts` 保留原有直接调用事务但委托同一收尾算法。Scheduler 独立 run stub 与 Service 直接调用都走同一策略实现，保留 schedule snapshot 与 late dirty 防护。验证 `tests/lifecycle/scheduler.spec.ts`、`service.spec.ts`、`settings.spec.ts`。
2. **Writer runtime 拆文件**：将 `WriterLifecycleRuntime` 及其 options 原样移入 `writer-runtime.ts`，只更新 Host 与测试 import；不移动测试、不改 transition/retry 逻辑。验证 Writer 测试、Host 测试与 typecheck。
3. **RPC contract 合并**：在 `src/contract.ts` 定义唯一 `MemoryOperationResult`、`RpcRequestMap`、`RpcResponseMap`，从 maps 派生 `RpcPayload`/`RpcValue`；Context、Controller 与 Client 改为引用 canonical 类型，Client 保留 transport 和既有类型 re-export。验证 Client/API 测试及三套 typecheck。
4. 做只读减法复核，运行全量 test、typecheck、lint、build、`npm pack --dry-run` 与 diff 检查；回填 §9。

## 5. 依赖与新增文件（每个一行理由）

| 名称 | 类型 | 为什么必须有 | 没有它怎么办 |
|---|---|---|---|
| `SPEC-structural-refactors.md` | 计划文档 | 记录跨模块边界、预算与验证结果 | 无运行时替代 |
| `src/lifecycle/writer-runtime.ts` | 既有类的物理新位置 | 用户明确要求将 Writer runtime 从 oversized Scheduler 拆出 | 继续混在 Scheduler，无法完成本项请求 |

## 6. 设计项台账（核心）

| 设计项 | 它解决什么场景 | 当前消费者数 | 当前是否必需 | 推迟的触发条件 | 删除会坏什么 |
|---|---|---|---|---|---|
| Scheduler 共用调度收尾方法 | Scheduler 调度和 Service 直接执行需要同一 metadata 策略 | 2 个：Scheduler、LifecycleService | 必需 | 不适用；本次请求即触发条件 | 直接调用或独立 Scheduler 的 dirty、完成时间和 retry 元数据回归 |
| `writer-runtime.ts` | 分离 Writer 可写状态切换与持久 intent 调度 | 2 个：Host、Writer 测试 | 必需 | 不适用；用户明确要求拆文件 | Host 无法激活/停用生命周期 Writer |
| canonical RPC maps | Host 与 Client 共享 15 个方法的请求/响应类型 | 3 个：Contract、Controller/Client、Client fixtures | 必需 | 不适用；当前已有两份重复定义 | 泛型 RPC 调用失去逐方法 payload/response 校验 |
| Client 类型 re-export | 既有 Client 内部与 fixtures 继续从 `rpc.ts` 取类型 | 2 个：Client store、Client fixtures | 必需 | 所有消费者改为直接引用 contract 后可删 | 当前测试与内部 import 破坏 |

## 7. 假设与风险

| ID | 假设内容 | 来源(Q#) | 若错，代价（具体到要重做哪部分） | 何时能发现 |
|---|---|---|---|---|
| A1 | 当前仍只需支持既有单 Host 单进程语义，没有新增跨实例调度执行体 | Q1 | 重做 Scheduler/Service 收尾协调约 80 行，并补跨实例竞争测试 | 全量 lifecycle 测试与真实多 Host 场景 |
| A2 | 内部深路径没有仓库外源码消费者；兼容面以 package exports 和现有 Client imports 为准 | Q2 | 恢复内部 re-export 或调整 import，单项约 1–10 行 | package 导出审查、typecheck/build 与下游反馈 |

## 8. 决策记录（人类反馈回写，只追加）

| 时间 | 问题 | 人类裁决 | 对设计的影响 |
|---|---|---|---|
| 2026-10-30 | 是否分别进行调度元数据收敛、Writer runtime 拆文件和 RPC contract 合并 | 用户明确 | 按三个独立阶段实施与验证，不扩大范围、不提交 |
| 2026-10-30 | 是否同时处理 localhost RPC 鉴权 | 用户明确延期 | 本批只合并类型，不增加 token、鉴权或运行时校验 |

## 9. 实际结果（实现后回填）

- 计划 vs 实际：新增本 spec 与 `writer-runtime.ts`，修改 10 个既有文件，新增依赖和运行时对外导出均为 0。源码/测试共 249 行新增、212 行删除，461 行变更、净增加 37 行；包含 Writer 的机械移动、RPC maps 迁移和 Scheduler 共用 metadata 策略。变更行数与 Scheduler 净减量超出预估，但文件、依赖、机制和任务范围未扩大。
- 减法 pass：删除 `consolidate.ts` 的独立调度收尾、Scheduler 内重复分支和 Client 的三份重复类型定义；未发现新的 A/B 类删除候选。保留 `retention.ts` 的直接调用事务并委托静态 helper，保留 Client 类型 re-export 供 store/fixtures 使用；协议字段、intent generation、schedule snapshot 与重试机制均不可删。
- 公开接口：package 运行时 exports、RPC wire shape、持久化 schema、localhost 鉴权边界和 CLI 行为均未改变；`MemoryOperationResult` 与 RPC maps 只有类型来源收敛到 canonical contract。
- 验证：调度阶段 66 项、Writer/Host 阶段 48 项、Client/API 阶段 72 项测试通过；每阶段 typecheck 通过。全量 32 个文件 273 项测试、lint、build、`git diff --check` 通过；`npm pack --dry-run` 通过，共 83 个文件，包含预期的 Writer `.js/.d.ts` 产物；运行时 contract 仍仅导出 `RPC_METHODS` 与 `RPC_ROUTE_PREFIX`，方法数为 15。
