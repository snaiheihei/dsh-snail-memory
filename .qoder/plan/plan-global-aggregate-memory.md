# Plan: global-aggregate-memory

依据 `SPEC-global-aggregate-memory.md`，按以下垂直切片实施，不修改 dsh 宿主源码，不安装到真实 Host。

1. **Store 聚合切片**：先用 Store/Projection 测试固定多 workspace 动态列表、来源保留、revision、旧 global 排除和 Markdown 聚合；再实现统一聚合 helper，供权威列表与投影复用。
2. **Context/API 单选切片**：先用注入、RPC、命令和工具测试固定 enable 互斥、disable、pending 恢复过滤、global 来源详情和 global 写入拒绝；再实现 Host 契约与服务。
3. **生命周期与 Client 切片**：先固定旧 global 不被整合/清理、Composer 三态单选和全局只读详情；再调整生命周期 scope、Composer、MemoryPage 与 locale。
4. **回归验证**：运行完整 Vitest、Host/Client/Test typecheck、lint、build，检查 git diff 和宿主工作区，报告未执行的真实 Host/UI/模型验证。

风险与处理：跨 workspace 同 id 通过来源 workspace 消歧；旧双层 enabled 以 workspace 归一化；旧 global 原始数据保留且不参与自动清理；聚合 revision 只由 workspace scope revision 合成，避免 Session 状态更新触发 refresh。
