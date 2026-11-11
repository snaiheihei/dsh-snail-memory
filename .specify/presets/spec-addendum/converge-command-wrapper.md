## feature 与追加任务约束

显式 `SPECIFY_FEATURE_DIRECTORY` 与 `.specify/feature.json` 的 `feature_directory` 不一致时停止，不得跨 feature 核对或追加任务。

下文追加行为缺口时，每个复选框同时包含验收引用、测试与实现，并沿用 tasks.md 的行为 ID、精确测试/实现路径和红→绿→重构格式；先定位这些路径，无法确定时停止并报告缺口。纯文档、配置或环境任务标记“无行为变更”，不伪造红灯。

## Change 归档的延期范围

> preset 注入，优先于下文。仅当用户输入包含 `CHANGE_ARCHIVE_DEFERRALS` 时应用本节；普通 converge 完全按下文处理每个任务。

`speckit.change archive` 会在用户逐项确认延期后，按 `change-command.md` 定义的 `CHANGE_ARCHIVE_DEFERRALS` 结构传入任务 ID、理由和确认日期；本命令不另维护第二份格式定义。

- 每个 ID 必须对应 `tasks.md` 中尚未勾选的任务，且带有用户理由与确认日期；输入缺失、伪造或含已勾选任务时停止，不执行归档。
- 构建下文的 Intent Inventory 时，排除这些任务本身。它们关联的 spec/plan 义务只有在全部由延期任务覆盖时才一并排除；同一义务仍有其他未延期任务或需求引用时继续核对。
- 延期只表示本次 Change 明确不接该范围，不表示代码已实现，也不勾选或改写任务。
- 除延期范围外仍有 findings 时，严格按下文追加任务并返回 `tasks_appended`。没有其他 findings 时保持 `tasks.md` 不变，返回 `converged`，并在结论中列出 `Deferred: <任务 ID>`。

判据：只有结构化输入中经用户确认的精确范围被豁免；其他需求、计划、宪法和任务仍按下文全量核对。

---

以下为核心 converge 命令流程。

{CORE_TEMPLATE}
