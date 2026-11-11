---
description: Start, inspect, or archive a lightweight Change while reusing the core spec-kit workflow.
---

## User Input

```text
$ARGUMENTS
```

将第一个参数解析为 `start`、`status` 或 `archive`，大小写不敏感。空动作或未知动作只显示用法：

```text
/speckit-change start <变更描述>
/speckit-change status [feature]
/speckit-change archive [feature]
```

Change 是工作流分支，本身不额外创建 Git 分支；core specify 已启用的扩展钩子仍按各自配置执行。一个 Change 只使用一个 `specs/<feature>/` 目录；`spec.md`、`plan.md`、`tasks.md` 继续是唯一规格、设计和任务真相。

## 定位 Change

`status` 与 `archive` 共用以下解析：

- 给出 `feature` 时，定位 `specs/<feature>/spec.md`；只接受 `specs/` 下已有的目录名。
- 未给出时，读取 `.specify/feature.json` 的 `feature_directory`。
- 文件或目录不存在时停止并报告；`spec.md` 缺少 `## Change` 时报告“该 feature 未由 Change 命令管理”。
- 只读取目标 Change，不扫描或拼接历史 Change。

判据：后续步骤只操作一个已确认的 `spec.md`，且不会把参数拼成仓库外路径。

## start：建立分支入口

1. 要求变更描述非空。`docs/spec-baseline.md` 存在时，先读 `## 按需阅读索引`，以变更描述明确提到的功能、模块或路径为锚点，选择直接对应该范围的行，最多 5 行；仓库已有文档明确建立的同义名称也可作为锚点，不自行猜测对应关系。

   - 对选中行，再读 `## 项目地图`、`## 现有流程与文档` 与 `## 验证入口` 中直接对应的行
   - 没有选中行时，只读 `## Change 流程`，在报告里写“本次未命中 baseline 条目”，继续 specify
   - 选中行只作上下文，不复制进变更描述；不追读未选中的小节。选中行链接的文档，仅在能回答本次现状、约束或流程问题时才继续读
   - 文件不存在时继续，不阻断，也不自动运行探测

   判据：读过的每一条都能指出变更描述或仓库已有术语中的锚点；未命中时明确写未命中，而不是用“没有相关信息”含糊带过。

2. 显式提供 `SPECIFY_FEATURE_DIRECTORY` 时，先确认目标位于 `specs/` 内且目标 `spec.md` 不存在；已存在规格或路径越界时停止，不调用 specify。然后实际调用活动集成中的 `speckit.specify`，把完整描述原样传给它，并等待其完成：

   ```text
   EXECUTE_COMMAND: speckit.specify
   ```

   发出标记不等于执行。保留其假设确认、模板解析、校验和扩展钩子；本命令不自行创建 feature 目录，也不复制 specify 的流程。

3. specify 未生成规格时停止。成功后从 `.specify/feature.json` 定位新 `spec.md`；显式目录的解析结果必须与该指针一致，否则停止。已有 `## Change` 或 `## Delta` 时报告并停止，避免重复追加。

4. 根据刚生成的用户故事、功能需求和验收标准，在 `spec.md` 末尾追加：

   ```markdown
   ## Change
   - Status: Active
   - Created: <实际日期 YYYY-MM-DD>
   - Archived: —
   - Baseline: <docs/spec-baseline.md；不存在则为 —>
   - Verification: —
   - Verified: —

   ## Delta
   | Operation | Affected capability | Spec references |
   |---|---|---|
   | <ADDED/MODIFIED/REMOVED/RENAMED> | <受影响能力；重命名写 旧名 → 新名> | <本文件已有 ID> |
   ```

5. Delta 至少一行；每个引用必须能在本 `spec.md` 中找到，例如 `US1`、`FR-003`、`SC-001` 或已有验收场景 ID。每行只索引变化的能力与引用，需求正文仍留在原章节。无法确定操作或引用时停止并指出缺口，不编造映射。

判据：新增内容只有上述两节，没有第二份需求正文；baseline 在 specify 前只作为按需导航。随后提示有参考材料时运行 `/speckit-references`，或按需运行 `/speckit-clarify`、`/speckit-plan`，不自动推进实现阶段；没有 baseline 时可提示 `/speckit-baseline`。产品参考需要影响需求时，搜集后再次运行 `/speckit-specify` 更新当前规格。

## status：按需读取

1. 读取目标 `spec.md` 的 Change 与 Delta 两节；`tasks.md` 存在时统计任务，不存在时明确写“尚未生成”。
2. 输出一次紧凑状态：feature 目录、Status、Created/Archived、Baseline、Verified（归档验证日期，缺失或为 — 时写“未归档验证”）、各 Delta 操作数量、任务完成数/总数、未完成任务 ID、Verification，以及已记录的 Deferred。
3. 保持所有文件字节不变，不回贴需求正文，不根据复选框猜测代码已经实现。

判据：报告中的数字能从当前文件重新计算，未读取其他 feature 的规格。

## archive：验证后原地归档

已是 `Status: Archived` 时报告既有归档日期并结束，不重复运行检查或改写文件。Active Change 的归档目标必须与 `.specify/feature.json` 的 `feature_directory` 完全一致；不一致时停止，因为 core converge 与评审只针对当前 feature，不能借用其他 Change 的结果。归档开始时固定该目标；显式 `SPECIFY_FEATURE_DIRECTORY` 与指针不一致时停止。converge 和评审完成后再次核对指针与显式目录均未偏离原目标，否则停止，不写归档状态。

1. **核对 Delta。** 对照最终 spec.md 逐行检查操作、能力和引用；引用必须仍存在，最终需求中的新增、修改、删除和重命名必须有对应索引。引用失效或覆盖缺失时停止，先只修复 Delta 索引再重新归档，不改写需求正文。
2. **核对任务。** `tasks.md` 必须存在。列出未勾选任务；没有未勾选项时继续。存在未勾选项时，逐项取得用户“延期”或“继续实现”的明确选择及延期理由，并等待回复。任一选择为继续实现时停止，提示运行 `/speckit-implement`。
3. **核对实现。** 实际调用 `speckit.converge` 并等待结果：

   ```text
   EXECUTE_COMMAND: speckit.converge
   ```

   有延期项时，把以下结构化输入传给该命令；没有延期项时不传，保持普通 converge 语义：

   ```text
   CHANGE_ARCHIVE_DEFERRALS
   - Task: <任务 ID>
     Reason: <用户理由>
     Approved: <用户确认日期>
   END_CHANGE_ARCHIVE_DEFERRALS
   ```

   返回 `tasks_appended` 时停止，保留新增任务并提示再次实现；只有明确返回 `converged` 才继续。延期范围之外的任何需求缺口都不能豁免。
4. **核对评审。** `.specify/extensions.yml` 中启用 `speckit.verify.standards` 时，采用本次会话中覆盖当前 diff 的最新完整报告；没有报告或报告之后又有代码改动时，实际调用它并等待结果：

   ```text
   EXECUTE_COMMAND: speckit.verify.standards
   ```

   只有报告明确给出“硬违规 0”或“无可评审改动”才继续；执行失败、结论缺失、结果过期或存在未解决硬违规时停止。判断项不阻断。“无可评审改动”必须同时证明 tracked diff 与 untracked 清单为空，且本 Change 没有实现任务产生的代码改动证据；否则停止。无法读取扩展配置时同样停止；未启用该扩展时记录未安装，不创建替代评审。
5. **写回证据。** 只修改目标 `spec.md` 的 `## Change`：
   - `Status` 改为 `Archived`，`Archived` 写实际日期。
   - `Verified` 写本次会话实际完成归档验证的日期（YYYY-MM-DD）；它只记录归档验证，不表示 Active 阶段的最近评审时间，也不沿用其他会话的报告日期。
   - `Verification` 写本次 converge 结论，以及 verify.standards 结论或未安装；引用本次会话已有报告，不新建报告文件。
   - 有延期项时，在该节追加 `- Deferred: <任务 ID> — <理由>（用户确认 <日期>）`，每个任务一行。

判据：成功归档后目录位置、Delta、需求正文、plan.md 和 tasks.md 均未改变；重复 archive 不产生额外写入。

## 边界

- `.specify/feature.json` 继续由 core 命令维护，本命令只读取，不建立 Change 注册表。
- 实现仍走现有 clarify、plan、tasks、implement、converge 与扩展钩子；安全、性能、可审查性沿用 core clarify 和既有门禁，不新增问询。
- 归档不合并 canonical capability specs，不移动目录；历史 Change 也不被视为当前系统完整规格。