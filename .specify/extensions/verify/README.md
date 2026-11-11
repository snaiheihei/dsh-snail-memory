# Post-Implement Verification（verify 扩展）

提供 `speckit.verify.standards` 命令，并把两道强制评审挂到 `after_implement`：

1. `speckit.analyze`（priority 1）：只读检查 spec、plan、tasks 的一致性。
2. `speckit.verify.standards`（priority 2）：只读评审当前基线后的完整工作区改动，包括已提交、暂存、未暂存和未跟踪文件。

## 为什么

实现任务完成不等于需求覆盖完整，也不等于代码符合项目标准。第一道评审检查规格闭环，第二道检查代码质量；两者都不改代码。

## Standards 评审边界

- 基线由用户提供；未提供时取本 feature 开始前的提交，再取不到才用 `HEAD`。
- tracked diff 与 untracked 清单同时为空，才报告“无可评审改动”。Git 不可用、基线解析失败或文件读取失败均报告“评审受阻”。
- 重要且影响合并或归档结论的完整评审，必须显式调用 fresh-context 子代理并等待完整报告。
- 硬违规必须指向已文档化标准；其余问题归入判断项。未迁移项目质量门时明确提示，不擅自补阈值。

本地 `speckit.implement` wrapper 会按数值 priority 升序执行钩子，同优先级保持 YAML 顺序。因此 analyze 与 Standards 默认先于 git 扩展的 commit（priority 10）运行，无需把 commit 调为 30。

## 安装

```powershell
specify extension add --dev ~\.dsh\skills\spec-presets\verify-gate
```

## 卸载

```powershell
specify extension remove verify
```

## 注意

- 钩子只对包含 `hooks.after_implement` 处理逻辑的命令模板生效；core `speckit.implement` 与本地 wrapper 均包含。
- 两个评审都是只读的；执行失败或结论缺失不能视为通过。
- 只安装扩展但未使用本地 implement wrapper 的宿主，应自行确认其实际钩子排序语义。
