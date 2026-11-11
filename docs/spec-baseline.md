# Project Baseline

> 探测日期：2026-11-11  
> 本文件是按需阅读索引，不是当前系统完整规格。

## 项目地图

| 区域 | 主要职责 | 入口 / 源码 | 证据 |
|---|---|---|---|
| Host 插件组合根 | 声明 Cordis 注入与配置，组装 Store、Context、Lifecycle、API、工具和写者生命周期 | `src/index.ts` | 已观察：`src/index.ts:24-47,68-214` |
| dsh 运行时适配 | 解析 Session 所属 workspace，切分蒸馏输入，选择辅助模型路由并适配 `ctx.llm` | `src/runtime.ts` | 已观察：`src/runtime.ts:10-16,80-191` |
| RPC 与斜杠命令 | 定义 Host ↔ Client 契约，注册同源 RPC 前缀和 `/memory` 命令 | `src/contract.ts`、`src/api/` | 已观察：`src/contract.ts:14-21,74-100`；`src/api/index.ts:9-31` |
| 上下文注入与工具 | 管理分层快照的 enable / refresh / disable、提交对账、详情读取和使用反馈 | `src/context/` | 已观察：`src/context/service.ts:64-140`；`src/context/tool.ts` |
| 记忆生命周期 | 统计完成轮次，调度蒸馏、consolidation、retention 和活动日志 | `src/lifecycle/` | 已观察：`src/lifecycle/service.ts:57-140`；`src/lifecycle/scheduler.ts` |
| 持久化与写者锁 | 维护权威状态、详情记录、Markdown 投影、写队列及单写者锁 | `src/store/` | 已观察：`src/store/store.ts:119-140`；`src/store/json.ts`、`src/store/lock.ts`、`src/store/projections.ts` |
| 安全策略 | 提供秘密扫描、脱敏和写入/模型输出安全策略 | `src/safety/` | 已观察：`src/lifecycle/service.ts:10`；`src/safety/scanner.ts`、`src/safety/policy.ts`、`src/safety/redact.ts` |
| Web Client | 注册输入区、主面板和侧栏 slots，提供 Memory UI、locale、RPC store | `client/src/entry.tsx`、`client/src/` | 已观察：`client/src/entry.tsx:36-68` |
| 测试 | 按 host、api、context、lifecycle、store、safety、client 分区的 Vitest 测试 | `tests/`、`vitest.config.ts` | 已观察：`vitest.config.ts:3-9`；`tests/**/*.spec.ts`、`tests/**/*.spec.tsx` |
| 构建与插件交付 | 编译 Host、打包浏览器 Client，生成 npm tarball、本地重装及市场 ZIP | `scripts/`、`package.json`、插件清单 | 已观察：`scripts/build.mjs:5-8`；`scripts/build-client.mjs:11-46`；`scripts/reinstall-dsh.ps1:3-19`；`dsh.plugin.json:27-30` |

## 现有流程与文档

| 事项 | 流程或命令 | 来源 | 状态 |
|---|---|---|---|
| 项目说明、安装、配置与数据布局 | 阅读项目 README；安装和日常使用以其为准 | `README.md` | 已观察：`README.md:1-109` |
| 记忆算法与设计取舍 | 按需阅读算法文档，不将其当作所有模块的逐行规格 | `MEMORY_ALGORITHM.md` | 已观察：`MEMORY_ALGORITHM.md:1-25,27-67` |
| 安装开发依赖 | `npm install` | `README.md:111-120` | 已观察；本会话未执行 |
| 开发构建 | `npm run build` | `package.json:40-47`；`scripts/build.mjs` | 已观察 |
| 类型检查、Lint 与测试 | `npm run typecheck`、`npm run lint`、`npm test`；watch 模式为 `npm run test:watch` | `package.json:40-47`；`README.md:111-120` | 已观察 |
| 本地重装与隔离验证 | `./scripts/reinstall-dsh.ps1 -RunTests`；可用 `-DshHome` 和 `-Profile` 隔离环境，`-SkipInstall` 仅构建打包 | `scripts/reinstall-dsh.ps1:21-47,128-168` | 已观察；脚本声明不发布、不修改 Git |
| npm 打包 | `npm pack`，由 `prepack` 自动执行构建 | `package.json:40-47`；`README.md:111-120` | 已观察 |
| 发布 | 已配置 npm 公共 registry；实际发布命令与审批流程未知 | `package.json:52-55` | 配置已观察；流程未知 |
| CI | 未知；未观察到 `.github/workflows/` 文件，未探测其他 CI 平台 | `.github/workflows/` | 未知 |
| 当前 Change 指针 | `.specify/feature.json` 不存在；当前指针未知 | `.specify/feature.json` | 未知 |

## 已文档化约束

- 运行兼容范围为 Node `>=22.19.0`、dsh `>=0.2.1-rc.3 <0.3.0-0`。 — `package.json:48-51`；`dsh.plugin.json:13,24-26`
- 记忆按 global / workspace 分层，Session 显式选择；注入只追加用户消息，不改写、替换或删除既有会话消息。 — `README.md:12-22`
- `state.v2.json` 是唯一权威状态，Markdown 投影可重建；审计日志只记录操作元数据。 — `README.md:85-102`
- 同一数据根目录仅一个写者，其余 Host 只读；写锁包含心跳、stale 回收和 fencing。 — `README.md:22`；`src/store/lock.ts`
- `cordis.patch.yml` 对插件行的 `config` 做整体替换，覆盖配置时必须保留所需键。 — `README.md:59-83`
- 模型调用走宿主 `ctx.llm`；写入与蒸馏前执行秘密扫描，模型输出按不可信数据处理，RPC 使用宿主同源路由。 — `README.md:104-109`；`src/runtime.ts:161-191`
- Client 使用宿主 Module Loader 的 CJS closure-factory，React 与 dsh 包保持 external，不重复打包 React。 — `README.md:136`；`scripts/build-client.mjs:7-35`
- Host、Client 和测试 TypeScript 配置启用 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`；Lint 禁止显式 `any` 并要求一致的类型导入。 — `tsconfig.json:10-17`；`tsconfig.client.json:8-16`；`tsconfig.test.json:8-16`；`eslint.config.js:14-17`

## 验证入口

| 目的 | 命令或入口 | 来源 | 执行情况 |
|---|---|---|---|
| Host 编译与 Client bundle | `npm run build` | `package.json:41`；`scripts/build.mjs` | 未执行（本会话仅静态探测） |
| 全量类型检查 | `npm run typecheck` | `package.json:42` | 未执行（本会话仅静态探测） |
| 静态规范检查 | `npm run lint` | `package.json:43`；`eslint.config.js` | 未执行（本会话仅静态探测） |
| 全量自动化测试 | `npm test` | `package.json:44`；`vitest.config.ts` | 未执行（本会话仅静态探测） |
| 定向测试 | `npm run test -- tests/<area>`，区域对应 `tests/host`、`tests/api`、`tests/context`、`tests/lifecycle`、`tests/store`、`tests/safety`、`tests/client` | `package.json:44-45`；`vitest.config.ts:5` | 未执行；命令形式由 npm 参数透传推断 |
| npm 包内容构建 | `npm pack` | `package.json:46`；`README.md:119` | 未执行（本会话仅静态探测） |
| dsh 组合层与本地重装验证 | `./scripts/reinstall-dsh.ps1 -RunTests`；组合检查使用 `dsh --profile web --dump-config` | `scripts/reinstall-dsh.ps1:159-216`；`README.md:42-48` | 未执行（本会话仅静态探测） |

## 按需阅读索引

| 当变更涉及 | 再读 | 原因 |
|---|---|---|
| 插件启动、宿主事件或资源释放 | `src/index.ts`、`src/runtime.ts`、`tests/host/` | 组合根、Session 事件接线和 dsh 适配集中在这里 |
| 快照、注入对账或记忆工具 | `README.md` 功能节、`src/context/`、`tests/context/` | 分层选择、append-only 注入、恢复和工具资格规则 |
| 蒸馏、整合、保留期或调度 | `MEMORY_ALGORITHM.md`、`src/lifecycle/`、`src/runtime.ts`、`tests/lifecycle/` | 确定性调度与模型语义处理的边界 |
| 状态格式、迁移、投影或写锁 | `README.md` 数据位置、`src/store/`、`tests/store/` | 权威状态、恢复、单写者与磁盘布局 |
| RPC、命令或 Host ↔ Client 契约 | `src/contract.ts`、`src/api/`、`tests/api/` | 方法契约、输入校验、路由与命令注册 |
| Web 面板、输入区按钮或客户端状态 | `client/src/entry.tsx`、`client/src/MemoryPage.tsx`、`client/src/ComposerMemory.tsx`、`client/src/rpc.ts`、`tests/client/` | slots、UI、同源 RPC 与客户端测试入口 |
| 秘密扫描、脱敏或模型输入输出安全 | `README.md` 隐私与安全、`src/safety/`、`src/runtime.ts`、`tests/safety/` | 安全策略和不可信模型边界 |
| 构建、打包、兼容性或本地安装 | `package.json`、`scripts/`、`dsh.plugin.json`、`plugin.json`、`cordis.patch.yml` | 产物入口、external、版本范围与交付流程 |

## Change 流程

- Change 历史位于 `specs/`；它不是当前系统完整规格。
- 新变更使用 `/speckit-change start`；按需读取本文件相关小节，不全量加载。

## 人工补充

无
