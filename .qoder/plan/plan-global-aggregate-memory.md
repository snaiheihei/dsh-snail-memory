# Plan: global-aggregate-memory

> 文件名保留用于历史追踪；当前实施目标以 `SPEC-global-aggregate-memory.md` 的独立 Global 修订为准，旧动态聚合计划已废止。

依据当前 Spec，按以下垂直切片实施，不修改 dsh 宿主源码，不安装到真实 Host。

1. **独立 Store 与 Promote**：先用 Store/Projection 测试固定独立 Global 列表、事务内深复制、并发幂等、长详情分片、双向隔离和 revision 基线；再实现 scope 枚举、Promote 与投影。
2. **独立生命周期**：先固定 workspace 20 小时与 Global 7 天、独立 dirty/intent、失败重试、热更新、retention 与蒸馏边界；再实现 Scheduler、Consolidation 和 Service。
3. **Context/API/Client**：先固定 Promote RPC、Global read/remove、无来源引用的快照与工具、详情 Promote/Delete 和 Settings；再实现 Host 与 Web 入口，保持单 active/pending/committed 快照协议。
4. **文档与回归验证**：同步相关 Spec、能力地图和 `MEMORY_ALGORITHM.md`，运行完整 Vitest、Host/Client/Test typecheck、lint、build 与 diff 检查，报告未执行的真实 Host/UI/模型验证。

风险与处理：Promote 查重与正文复制必须位于同一 Store 写事务；来源与副本不得共享详情所有权；旧聚合 revision 只建立一次独立基线；两类 dirty、retention 和 Session 游标必须保持正交。
