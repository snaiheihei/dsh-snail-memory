---
name: speckit-plan
description: Execute the implementation planning workflow using the plan template
  to generate design artifacts.
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: preset:spec-addendum
---

# Speckit Plan Skill

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


## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Pre-Execution Checks

**Check for extension hooks (before planning)**:
- Check if `.specify/extensions.yml` exists in the project root.
- If it exists, read it and look for entries under the `hooks.before_plan` key
- If the YAML cannot be parsed or is invalid, do not skip silently: tell the user that `.specify/extensions.yml` could not be read (include the parser error) and that no hooks were checked, including any mandatory (`optional: false`) hooks registered there, then continue normally
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- When constructing command invocations from hook command names, replace dots (`.`) with hyphens (`-`). For example, `speckit.git.commit` → `/speckit-git-commit`.
- For each executable hook, output the following based on its `optional` flag:
  - **Optional hook** (`optional: true`):
    ```
    ## Extension Hooks

    **Optional Pre-Hook**: {extension}
    Command: `/{command}`
    Description: {description}

    Prompt: {prompt}
    To execute: `/{command}`
    ```
  - **Mandatory hook** (`optional: false`):
    ```
    ## Extension Hooks

    **Automatic Pre-Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}

    Wait for the result of the hook command before proceeding to the Outline.
    ```
    After emitting the block above you MUST actually invoke the hook and wait for it to finish before continuing. Run it the same way you would run the command yourself in this agent/session (the invocation may differ from the literal `{command}` id shown above, e.g. a skills-mode agent runs it as `/skill:speckit-...` or `$speckit-...`). Emitting the block alone does not run the hook.
- If no hooks are registered or `.specify/extensions.yml` does not exist, skip silently

## Outline

1. **Setup**: Run `.specify/scripts/powershell/setup-plan.ps1 -Json` from repo root and parse JSON for FEATURE_SPEC, IMPL_PLAN, FEATURE_DIR, BRANCH. For single quotes in args like "I'm Groot", use escape syntax: e.g 'I'\''m Groot' (or double-quote if possible: "I'm Groot").

2. **Load context**: Read FEATURE_SPEC and `.specify/memory/constitution.md`. Load IMPL_PLAN template (already copied).

3. **Execute plan workflow**: Follow the structure in IMPL_PLAN template to:
   - Fill Technical Context (mark unknowns as "NEEDS CLARIFICATION")
   - Fill Constitution Check section from constitution
   - Evaluate gates (ERROR if violations unjustified)
   - Phase 0: Generate research.md (resolve all NEEDS CLARIFICATION)
   - Phase 1: Generate data-model.md, contracts/, quickstart.md
   - Re-evaluate Constitution Check post-design

## Mandatory Post-Execution Hooks

**You MUST complete this section before reporting completion to the user.**

Check if `.specify/extensions.yml` exists in the project root.
- If it does not exist, or no hooks are registered under `hooks.after_plan`, skip to the Completion Report.
- If it exists, read it and look for entries under the `hooks.after_plan` key.
- If the YAML cannot be parsed or is invalid, do not skip silently: tell the user that `.specify/extensions.yml` could not be read (include the parser error) and that no hooks were checked, including any mandatory (`optional: false`) hooks registered there, then continue to the Completion Report.
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- When constructing command invocations from hook command names, replace dots (`.`) with hyphens (`-`). For example, `speckit.git.commit` → `/speckit-git-commit`.
- For each executable hook, output the following based on its `optional` flag:
  - **Mandatory hook** (`optional: false`) — **You MUST emit `EXECUTE_COMMAND:` for each mandatory hook**:
    ```
    ## Extension Hooks

    **Automatic Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}
    ```
    After emitting the block above you MUST actually invoke the hook and wait for it to finish before continuing. Run it the same way you would run the command yourself in this agent/session (the invocation may differ from the literal `{command}` id shown above, e.g. a skills-mode agent runs it as `/skill:speckit-...` or `$speckit-...`). Emitting the block alone does not run the hook.
  - **Optional hook** (`optional: true`):
    ```
    ## Extension Hooks

    **Optional Hook**: {extension}
    Command: `/{command}`
    Description: {description}

    Prompt: {prompt}
    To execute: `/{command}`
    ```

## Completion Report

Command ends after Phase 1 design. Report branch, IMPL_PLAN path, and generated artifacts.

## Phases

### Phase 0: Outline & Research

1. **Extract unknowns from Technical Context** above:
   - For each NEEDS CLARIFICATION → research task
   - For each dependency → best practices task
   - For each integration → patterns task

2. **Generate and dispatch research agents**:

   ```text
   For each unknown in Technical Context:
     Task: "Research {unknown} for {feature context}"
   For each technology choice:
     Task: "Find best practices for {tech} in {domain}"
   ```

3. **Consolidate findings** in `research.md` using format:
   - Decision: [what was chosen]
   - Rationale: [why chosen]
   - Alternatives considered: [what else evaluated]

**Output**: research.md with all NEEDS CLARIFICATION resolved

### Phase 1: Design & Contracts

**Prerequisites:** `research.md` complete

1. **Extract entities from feature spec** → `data-model.md`:
   - Entity name, fields, relationships
   - Validation rules from requirements
   - State transitions if applicable

2. **Define interface contracts** (if project has external interfaces) → `/contracts/`:
   - Identify what interfaces the project exposes to users or other systems
   - Document the contract format appropriate for the project type
   - Examples: public APIs for libraries, command schemas for CLI tools, endpoints for web services, grammars for parsers, UI contracts for applications
   - Skip if project is purely internal (build scripts, one-off tools, etc.)

3. **Create quickstart validation guide** → `quickstart.md`:
   - Document runnable validation scenarios that prove the feature works end-to-end
   - Include prerequisites, setup commands, test/run commands, and expected outcomes
   - Use links or references to contracts and data model details instead of duplicating them
   - Do not include full implementation code, model/service/controller bodies, migrations, or complete test suites
   - Keep this artifact as a validation/run guide; implementation details belong in `tasks.md` and the implementation phase

**Output**: data-model.md, /contracts/*, quickstart.md

## Key rules

- Use absolute paths for filesystem operations; use project-relative paths for references in documentation
- ERROR on gate failures or unresolved clarifications

## Done When

- [ ] Plan workflow executed and design artifacts generated
- [ ] Extension hooks dispatched or skipped according to the rules in Mandatory Post-Execution Hooks above
- [ ] Completion reported to user with branch, plan path, and generated artifacts
