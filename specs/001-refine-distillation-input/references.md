# References

> Updated: 2026-11-11  
> 仅作按需索引；适用阶段为 specify / plan / implement，tech-gate 与 plan 共用 plan 条目。

| ID | 类型 | 来源 | 版本 / 访问日期 | 适用阶段 | 可借鉴点 | 证据与限制 |
|---|---|---|---|---|---|---|
| REF-001 | project | `C:\Users\503247565\OneDrive - GE HealthCare\Desktop\program\github\deepseek-harness` | `0.2.2-rc.1`；commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`；2026-11-11 | plan / implement | 真实用户应以 `user/message` 且 `source.kind = user` 判定，不能只看 user role。过滤与处理进度应依据原始事件 `seq` 顺序；即使筛选后没有有效内容，也需要确认已检查范围，避免遗漏或重复。 | `packages/llm/llm/src/message.ts:103-115,135-180`；`packages/core/session/src/types.ts:287-315,339-393`；`packages/core/session/src/index.ts:639-657,704-770`。限制：`snapshotEvents` 已弃用新调用；append 不等待持久化，跨重启语义需另核对持久化检查点，不能依赖 `turnId`。 |
| REF-002 | data | `C:\Users\503247565\.dsh\snail_memory` | `state.v2.json` format 2、revision 1630；2026-11-11 | specify / plan | 现有 `sourceRefs` 提供 `sessionId` 与可选 `eventSeqs`，可作为验证新记忆用户来源的追溯入口。验收历史样本时需结合原 Session 事件确认来源，不能把历史条目直接当作噪声标签。 | `state.v2.json:1-92`；`settings.v1.json:1-15`。限制：仅有界读取结构与少量样本，未逐条审计或复制记忆正文，未修改数据；状态文件不保存原事件类型或 `source.kind`，不能仅凭该文件归因噪声或自动清理历史记忆。 |
