## 规划硬性约束

> preset 注入，优先于下文。

### 一、固定 feature，先读 tech-decisions.md

显式 `SPECIFY_FEATURE_DIRECTORY` 与 `.specify/feature.json` 的 `feature_directory` 不一致时停止，先修正指针；本命令不得在一个 feature 读取规格、在另一个 feature 写规划。

技术选型由 `/speckit-tech-gate` 或第四节的无扩展内联评审拍板，结论在 `specs/<feature>/tech-decisions.md`。

**读到它**：`plan.md` 的 Technical Context 照它填，并在小节末尾写一行
`> 选型依据：见 tech-decisions.md`。

**读不到**（文件缺失 / 无用户确认原话 / 无确认时间）：本次已执行 `speckit.tech.gate` 时停止并报告决策文件缺口；没有启用的 tech-gate 时先按第四节完成内联评审并写好决策文件，再继续。其他 `before_plan` 钩子不算技术选型。

**写 research.md 时分工**：`research.md` 按核心模板的 `Decision / Rationale / Alternatives`
记录**非选型**研究（最佳实践、集成模式、未知项调研）；选型域不重复展开，只写一行
`见 tech-decisions.md`。Technical Context 里没被决策覆盖的域，仍按核心规定标 `NEEDS CLARIFICATION`。

### 二、新模块过三问

每引入一个新模块或抽象，先回答：

- **删除测试**：删掉它，复杂度散到 N 个调用方，还是消失？散开 → 它挣了钱；消失 → 直通壳。
- **seam 真实吗**：两侧真会变、有两个以上实现吗（生产 + 测试算两个）？单实现 → 只是间接层。
- **接口比实现小吗**：调用方要学的，明显少于藏在里面的？一样大 → 合并回调用方。

两问答不上来，这个模块先不建。结论按核心模板记进 `plan.md` 的 `Complexity Tracking`——
只在它确实构成需要辩护的复杂度时占一行，不为每个模块另建表格。

### 三、存量项目按需读取 baseline

当前 `spec.md` 的 Change 元数据指向一个存在的 baseline 时，以 Delta 行的「受影响能力」为锚点，从 `## 按需阅读索引` 选择直接对应该范围的行，最多 5 行；仓库已有文档明确建立的同义名称也可作为锚点，不自行猜测。对选中行，再读 `## 项目地图`、`## 现有流程与文档` 与 `## 验证入口` 中直接对应的行。无选中行时只读 `## 现有流程与文档`，并在报告写明未命中。选中行只作技术上下文，不替代仓库当前证据；直接链接的文档只有在能回答本次集成或验证问题时才继续读；不追读未选中的小节。

- baseline 缺失或字段为 `—` 时继续，不自动运行 `/speckit-baseline`，也不把它设为 plan 门禁。
- baseline 与仓库当前证据冲突时以仓库为准，报告过期条目；不要在 plan 中顺手改写 baseline，更新仍走 `/speckit-baseline` 的确认流程。

判据：plan 能引用本次涉及区域已有的流程和文档，未因“可能有帮助”加载无关项目档案。

### 四、参考材料按需读取

当前 feature 存在 `references.md` 时，只读取标记 `plan` 且与本次设计相关的条目；tech-decisions 或 research 已引用的 REF-ID 可直接定位。只有回答集成、最佳实践或未知项时才回读对应原材料，不把全部参考注入 plan。

参考方案不能绕过技术门禁或覆盖已确认决策；`research.md` 用 REF-ID 标明非选型研究的出处，plan 不复述参考摘要。新增方案参考需要改变选型时，显式重新运行技术评审并取得用户确认。

### 五、没有技术门禁时

`.specify/extensions.yml` 没有启用的 `speckit.tech.gate`，且当前 feature 没有有效决策文件时，在本命令内完成一次选型评审：
每域 ≥2 候选、五维打分、用户拍板后按 `speckit.tech.gate` 的格式写入 `tech-decisions.md`，再写 plan 文档。五维与口径见 `speckit.tech.gate`。其他 `before_plan` 钩子不影响此降级。

不变式：新项目按产品优先，本机环境不参与选型；旧项目沿用现有栈，新依赖先问，迁移独立提案。

---

以下为核心 plan 命令流程。

{CORE_TEMPLATE}
